<!--
SPDX-FileCopyrightText: 2026 Quality Runtime contributors
SPDX-License-Identifier: Apache-2.0
-->

# 17. Discarding a control that was never in effect

## Status

Accepted.

## Context

A control's lifecycle was `draft → active → retired → draft` when this was written, and nothing else ([ADR 0003](0003-tenant-isolation-with-row-level-security.md) enforces the tenancy; the moves themselves are a rule the API keeps). There is no `DELETE`.

That left an abandoned draft with no disposal at all. Somebody starts authoring a control, thinks better of it, and the only way to be rid of it is to put it **into effect** and then retire it — which writes two events into audit history saying a control was in effect when it never was, and leaves a `retired` row claiming to have once been in effect. The alternative is to leave it in the drafts forever, where it clutters the one list that is supposed to show what is being worked on.

So one of two things had to change: allow `draft → retired`, or allow a draft to be deleted.

## Decision

**A control that was never in effect can be deleted. Nothing else can.**

`DELETE /api/v1/organizations/{organizationId}/controls/{controlId}` answers `204` when the control never took effect, `409` when it did, and `404` when it is not there or belongs to someone else.

**A draft has to mean "never took effect", and the database has to hold that.** The first version tested `status = 'draft'` and was wrong: `retired → draft` was then a legal move, so `active → retired → draft` turned a control that _was_ in effect into a plain draft in three ordinary requests, and a status test let it be erased. The subtler version is the same hole in SQL: a policy is re-evaluated per statement, so an `UPDATE … SET status = 'draft'` followed by a `DELETE` in one transaction defeats a status test — the delete really does see a draft.

`control` therefore carries `activated_at`, when it first became active. For a while the policy tested that column instead of the status, which kept `retired → draft` and moved the whole meaning of "was ever in effect" into a timestamp. That still allowed a previously active control to be called a draft, so the transition was removed: **the lifecycle is `draft → active → retired`, one way.** A retired control stays retired, and what replaces it is a new control, and the retired one stays a distinct record of what was in effect. Reactivation can be added when a workflow needs it; a status that can be revived is probably misnamed.

So the `DELETE` policy tests `status = 'draft'` again, and it means what it says because of the rules below the API:

- **A trigger owns `activated_at`.** It stamps a control the first time it becomes active, by whatever path, and refuses any other write — a caller can neither backdate it, forge it, nor clear it. Allowing `UPDATE … SET status = 'draft', activated_at = NULL` would make a previously active control deletable again. A policy cannot prevent that, because `WITH CHECK` sees only the new row; a `BEFORE INSERT OR UPDATE` trigger is the only thing in PostgreSQL that can compare the two.
- **A CHECK ties a draft to a null stamp** (`control_took_effect_unless_draft`). With the stamp immovable, nothing that took effect can become a draft again, and nothing is created active-and-unstamped or retired.
- **The same trigger keeps a retired control retired.** A retired row keeps its stamp, so the CHECK would admit `retired → active`; only a trigger can see that the row was retired before. It is `control_lifecycle_enforce`: the two lifecycle rules that need a row's past, and nothing else.

The route does not set the column at all, so there is no second place for the rule to be forgotten.

**Why not `draft → retired`.** `docs/data-model.md` already says what `retired` is for: _a control that was once in effect is part of the record_. That is the whole reason retiring beats deleting — there is something worth keeping. A draft was never put into effect here, so retiring it would record that it had been. It is not nothing — it may carry mappings, and even evidence — but what it carries is dealt with deliberately: it can be discarded only once it carries no evidence, its mappings go by cascade, and its audit history stays. Keeping the row itself would not be conservatism, it would be clutter. And `retired` means "no longer in effect", which misdescribes something that never was: the two would become indistinguishable in exactly the list where the distinction matters.

**The rule is a policy, not a route.** `control` had one `FOR ALL` policy, which cannot say _delete only these rows_. It is now four per-command policies, and the `DELETE` one admits only a draft. The route answers 409 with something a person can act on; PostgreSQL is what makes the rule true, which is the same shape as evidence finality ([ADR 0012](0012-evidence-and-attestation.md)) and audit append-only ([ADR 0005](0005-audit-history.md)).

Splitting the policy costs nothing elsewhere: `SELECT … FOR UPDATE` is charged to `UPDATE`, so the handler can still lock any control before deciding about it, whatever its status.

**A control carrying evidence is refused.** `evidence`'s foreign key to `control` is `ON DELETE restrict` ([ADR 0014](0014-the-runtime-role-owns-nothing.md)), so removing a control that has evidence fails in the database. The route asks first and answers `409 has_evidence`, because a foreign key violation surfacing as a 500 tells a client nothing.

The deletion route holds `SELECT … FOR UPDATE` on the control while checking for evidence. Evidence creation takes `FOR KEY SHARE` when reading the control and holds it through insertion. Waiting until the foreign key check to take that lock would allow a deletion between the read and insert, producing a `500`. With both reads protected, the losing request answers `404` when the control was deleted first, or `409 has_evidence` when evidence was recorded first. [ADR 0020](0020-testing-races.md) records the tests for both interleavings.

**So unattested evidence gained a `DELETE` of its own.** Without it this refusal was a dead end: a control that ever had evidence recorded against it could not be discarded at all, and the only escape was to activate and retire it — the exact thing this ADR exists to avoid. The policy was already there. `evidence`'s `DELETE` policy has admitted only unattested rows since [ADR 0012](0012-evidence-and-attestation.md); no route had ever asked. Attested evidence is still refused, and then the control stays too, which is correct: attested evidence must go on naming what it was evidence of. Discarding evidence takes its `file` rows by cascade, and the bytes stay on the volume, so the audit event names the filenames — the only record left of them, and [ADR 0018](0018-one-history-rather-than-one-per-record.md) is what made that event readable.

**The deletion is audited, and the history outlives the row.** `audit_event.resource_id` is a plain column rather than a reference, so the events describing a control survive it. A `deleted` event carries `before` and no `after`, mirroring a creation's `after` and no `before`.

## Consequences

`audit_event.action` gains a fourth verb. `Change` became a union discriminated on it rather than two optional fields, so that a creation cannot carry a `before` nor a deletion an `after`; both columns were already nullable.

`control.activated_at` is published on the control: when it first took effect is part of its record, and the status alone no longer says when that was.

**History can now name a control that no longer exists.** When this was written the only route to those events was `GET /controls/{controlId}/history`, which answered 404 once the control was gone — so discarding a control put its history beyond every route in the product. [ADR 0018](0018-one-history-rather-than-one-per-record.md) closed that: history is its own collection now, and a discarded control's events, including its deletion, stay readable at `?resource={controlId}`.

**Deleting is not undoing.** A draft removed by one member is gone for another who was looking at it. That was unpreventable when this was written; [ADR 0019](0019-conditional-writes.md) since gave every mutation an optional `If-Match`, so a caller who quotes the version it read is refused with 412 rather than discarding something that moved underneath. It remains unconditional for a caller who does not ask.

**The mappings go with it.** `control_requirement` cascades from `control`, so discarding a draft removes its requirement mappings. That is right — a mapping is a statement that _this control_ addresses a requirement, and it means nothing without the control — but it is a cascade, and cascades are not audited ([ADR 0010](0010-mapping-controls-to-requirements.md)).

**Retirement is still what deletion usually means.** This is the narrow exception for records that never claimed anything, not a general disposal mechanism. Standards and requirements are unaffected; the question of how to dispose of an imported standard nobody adopted is still open.

**Discarding is not refused while impersonating**, unlike attesting. Attesting is a signature and cannot be delegated; discarding is ordinary work an administrator may do on a member's behalf, and the audit event names both. That is a choice rather than an oversight.
