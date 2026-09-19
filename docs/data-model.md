# Data model

What Quality Runtime knows: entities, relationships, organization scoping, identifiers, lifecycle state, versioning, and the invariants the schema enforces.

The schema lives in [`packages/db`](../packages/db): table definitions in `schema/`, checked-in SQL in `migrations/`.

## Identity and tenancy

These tables are owned by [Better Auth](https://better-auth.com) and defined in `schema/auth.ts`. See [ADR 0001](adr/0001-drizzle-orm-and-better-auth.md) for why, and for the deviations from its generated schema.

| Table          | Holds                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| `user`         | A person. Instance-wide identity, independent of any organization                      |
| `account`      | A credential or linked social provider; unique per (provider, external id)             |
| `session`      | An authenticated session, and the organization the user last selected                  |
| `verification` | Short-lived tokens for email verification, password reset, and OTP delivery            |
| `two_factor`   | TOTP secrets and backup codes                                                          |
| `organization` | **The tenant boundary.** Every tenant-owned record belongs to exactly one organization |
| `member`       | A user's membership and role in an organization; unique per (org, user)                |
| `invitation`   | An invitation to join an organization, including its status                            |

## Identifiers

Every generated row identifier uses `<prefix>_<random>`, for example `usr_v1stgxr8z5jdhi6b`. The prefix identifies the record type, and the random portion is a lowercase base36 value generated with [Nano ID](https://github.com/ai/nanoid). [ADR 0002](adr/0002-prefixed-identifiers.md) documents the decision. `packages/db/id.ts` is the single place where identifiers are generated.

| Table          | Prefix | Random length |
| -------------- | ------ | ------------- |
| `invitation`   | `inv_` | 24            |
| `user`         | `usr_` | 16            |
| `session`      | `ses_` | 16            |
| `account`      | `acc_` | 16            |
| `verification` | `ver_` | 16            |
| `organization` | `org_` | 16            |
| `member`       | `mem_` | 16            |
| `two_factor`   | `tfa_` | 16            |
| `control`      | `ctl_` | 16            |
| `audit_event`  | `aud_` | 16            |
| `standard`     | `std_` | 16            |
| `requirement`  | `req_` | 16            |
| `evidence`     | `evd_` | 16            |
| `file`         | `fil_` | 16            |

A row identifier is not a credential: `session.token` authenticates a session and `verification.value` proves a verification. `invitation` is wider because Better Auth takes an invitation by id. Identifiers are allocated before insertion and reveal no row count. Each `id` column enforces its table's prefix, length, and alphabet with a CHECK constraint, so an identifier belonging to another table — or one carrying uppercase — is rejected rather than stored. Join tables need no separate identifier: `control_requirement` uses `(control_id, requirement_id)` as its primary key.

## Domain entities

Domain tables are tenant-owned: each carries an `organization_id` referencing the organization it belongs to, and deleting an organization deletes its rows. That column records **ownership, not permission** — it says which tenant a row belongs to, never that a given request may read or change it. Authorization still resolves the caller's `member` row (TENANT-01, and see [security](security.md)).

PostgreSQL enforces the boundary: every table here has row-level security enabled and forced, and is reached through `withOrganization`, which scopes a transaction to one organization. A query that forgets its tenant predicate returns that organization's rows rather than everyone's, and a transaction with no organization set sees nothing. [ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md) records the design; adding a tenant-owned table means adding its policy, and `migrations.test.ts` fails until you do.

### Standard and requirement

A standard is something an organization works to: a published one such as ISO 9001, or a policy it wrote itself. A requirement is one thing that standard asks for. Both are defined in `schema/standard.ts`; [ADR 0008](adr/0008-standards-and-requirements.md) records the design.

**An edition is part of a standard's identity.** `standard` carries `name` and `edition` and is unique on `(organization, name, edition)`, so ISO 9001:2015 and ISO 9001:2026 are two rows rather than one row with a version. A requirement belongs to an issue, and a clause that changed between issues is a different requirement that happens to share a reference. Relating requirements across editions is not modelled yet.

**Every organization holds its own copy.** There is no shared catalogue: a standard is imported into an organization — whole, with its requirements, in one request and one transaction ([ADR 0009](adr/0009-importing-a-standard.md)) — and becomes that organization's rows, keeping every domain row owned by exactly one organization.

| Column      | Holds                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `reference` | How the standard refers to the requirement — `7.5.3`, `A.5.1`, `CC6.1` |
| `title`     | What the requirement is about                                          |
| `text`      | The requirement as stated, where the deployment may store it           |
| `position`  | Where it falls in the standard's own order                             |

`reference` is unique within a standard and means nothing outside it. It is how people cite a clause — in a commit message, a pull request, a checklist — so `?reference=` on a standard's requirements resolves one to its requirement by exact match ([ADR 0011](adr/0011-reading-a-mapping-from-both-ends.md)). `position` is **not** unique, so a clause can use an occupied position without renumbering later clauses. Requirements are ordered by `(position, id)`; ties are broken by identifier. `text` is **nullable on purpose**: the wording of a published standard is usually copyrighted, and a licence to read one is not a licence to store it — a requirement tracked by reference and title alone can still be mapped to controls and read with their evidence. `position` exists because clause references do not sort: `7.10` precedes `7.9` lexically.

A requirement carries its own `organization_id` and references its standard by `(standard_id, organization_id)` together, so a requirement in one organization pointing at a standard in another cannot be written at all (TENANT-01). Every tenant-owned child should be related to its parent the same way; a reference to something instance-wide, such as `user`, takes an ordinary foreign key instead.

Both are ordinary mutable rows: importing an edition does not freeze it, and identity is the exact string once surrounding whitespace is removed — `ISO 9001` and `ISO9001` are two standards. Deleting a standard deletes its requirements.

### Control

A control is something an organization does to satisfy a requirement — a measure, a practice, a safeguard. It is defined in `schema/control.ts` and is deliberately narrow: the organization it belongs to, a name, an optional description, and a lifecycle status.

Lifecycle:

```text
gone ◀── draft ──▶ active ──▶ retired
```

- `draft` — being authored; claims nothing.
- `active` — in effect, and may be relied on. The status does not say a requirement is met or that the control was operated: its mappings record what it is meant to address, and its evidence records its operation.
- `retired` — no longer in effect, but kept: a control that was once in effect is part of the record. Retiring is what deletion should usually be.

The schema admits exactly these three values and no more. The API answers for the moves between them — the arrows above are the only ones — and setting the status a control already has is a no-op. The lifecycle runs one way, and PostgreSQL holds it to that whatever writes the row ([ADR 0017](adr/0017-discarding-a-draft-control.md)). A control in effect is withdrawn deliberately rather than quietly returned to draft, and a withdrawn one stays withdrawn: what replaces it is a new control, and the retired one stays a distinct record of what was in effect. There is no `active → draft`, and nothing leaves `retired`. A control is always created as a `draft`; the create request cannot choose otherwise.

**A control that was never in effect can be discarded** ([ADR 0017](adr/0017-discarding-a-draft-control.md)). `DELETE` removes it outright, and answers 409 otherwise. The reason is the one above: retiring preserves a control that was once in effect, and one that never took effect was not — calling it `retired` would claim it had been.

The `DELETE` policy admits only a `draft`, and PostgreSQL is what makes "draft" mean "never took effect" rather than the API. `activated_at` records when a control first became active; a trigger sets it and refuses any other write to it, and a CHECK allows a draft exactly when it is null. So nothing that was in effect can be a draft again — not through the API, and not through raw SQL, including an `UPDATE` and a `DELETE` in one transaction. The trigger has to be a trigger: a policy cannot compare a row to what it used to be, and anything able to clear the stamp could turn a control that was in effect back into a deletable draft.

A control still carrying evidence is refused too, because `evidence` restricts rather than cascades. Discard the evidence first. Unattested evidence can be discarded; attested evidence cannot, and then the draft stays — a draft cannot be retired, and attested evidence goes on naming what it was evidence of. Discarding a control takes its requirement mappings with it, by cascade, and a cascade is not audited.

The deletion itself is audited, and that history outlives the row: `resource_id` is a plain column, not a reference. It stays readable afterwards at `GET /history?resource={controlId}` — a history reachable only through a live record would disappear exactly when it is most wanted ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)).

Names are not unique within an organization: a name is a label, not an identifier, and two teams authoring similar controls is a state to reconcile rather than one to reject at insert time. A name that is blank or only whitespace is rejected.

Fields a quality system eventually wants — category, framework, test method, review cadence, effectiveness, owner — are deliberately absent until a workflow needs them. Ownership in particular waits on how domain responsibility should relate to Better Auth membership.

A control row is mutable: editing one overwrites it. What it was is recorded in `audit_event` rather than kept on the row, so the history of a control is a query rather than a column. Versioned prior states (VERSION-01) — a numbered revision a reader can cite and return to — are still not implemented, and are a separate thing from the change log below.

### Control and requirement

`control_requirement` records which controls answer to which requirements. It is read from both ends — the requirements a control answers to, and the controls answering to a requirement — and it is what `?mapped=false` uses to say which clauses of a standard nobody has taken up ([ADR 0011](adr/0011-reading-a-mapping-from-both-ends.md)). _Mapped_ is not _covered_: a link says a control is meant to address a requirement and nothing about whether it does. It is keyed by the pair and carries only when the link was made — no rationale, no coverage strength — until something reads one ([ADR 0010](adr/0010-mapping-controls-to-requirements.md)). Both references are composite and share one `organization_id`, so a link between organizations cannot be stored.

The set is replaced whole rather than added to one link at a time, and a mapping change is recorded against the control, not the link. Deleting a control, a requirement, or a requirement's standard removes the links to it — silently, because a cascade is not a change the application made.

### Evidence

A record that a control was actually operated: a review performed, a restore tested, a training completed. It belongs to a control, carries `occurred_at` — when the thing happened, not when the row was written — and is listed in that order. It may not be in the future, beyond a five-minute allowance for a client's clock; a date before the control existed is fine, because recording earlier work is ordinary. It is also read from a requirement: the evidence of the controls currently mapped to it, which is a view through the mapping rather than a claim that the requirement is met. [ADR 0012](adr/0012-evidence-and-attestation.md) records the design.

**A policy is a test, not a lock.** The rules below are enforced by row-level security, which decides what a row may be — it cannot decide when two transactions may act. Under `read committed` a predicate reads a snapshot taken before a concurrent transaction committed, so a handler that reads state and then writes on the strength of it also has to hold a row lock the other writer contends for. Where that is load-bearing, [ADR 0020](adr/0020-testing-races.md) names the place and the lock.

**Evidence is the first finalised record here.** Until someone attests it, it is an ordinary draft. Attesting records who vouched and when, and after that PostgreSQL will not let the application change or delete the row at all: the `UPDATE` and `DELETE` policies see only unattested rows (VERSION-01). Correcting attested evidence means recording new evidence, not editing the old. Attesting is refused while impersonating — it is a signature, not work that can be done on someone's behalf — and is the one mutation that _requires_ `If-Match`, so that what was signed is what was read. Deleting the organization still removes everything in it, cascades being outside row security — evidence is final against the application, not against a tenant being removed.

A validity period is deliberately absent. Evidence does go stale, but staleness is a relationship between a control's expectations and an evidence date — the cadence belongs to the control, and nothing reads one yet.

### Audit event

Domain API mutations record changes in the same transaction as the change itself ([ADR 0005](adr/0005-audit-history.md)). A change PostgreSQL makes on its own — a foreign key's cascade removing rows — writes nothing, which is a known gap rather than a decision. It names the actor, the action, the record, and the fields that moved.

| Column                         | Holds                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `actor_type`, `actor_id`       | Who acted: `user` or `system`, and their identifier                              |
| `actor_label`                  | How the actor was named at the time                                              |
| `action`                       | A verb — `created`, `updated`, `attested`, `deleted`                             |
| `resource_type`, `resource_id` | Which record it happened to                                                      |
| `before`, `after`              | The fields that changed; `before` is null for a creation, `after` for a deletion |
| `created_at`                   | When the change happened, not when the row was written                           |

An administrator impersonating a member is the actor, because they are accountable for what happened; the member is recorded as whose account it went through.

Neither `actor_id` nor `resource_id` is a foreign key. Both the actor and the record can be deleted, and history that vanishes with them is not history (AUDIT-01) — `actor_label` exists for the same reason, since an identifier alone means nothing to a reader once the row is gone.

`before` and `after` carry a record's own fields — for a field edit, only those that differ. Payloads can also describe related records: a standard import records its requirement count, and a mapping update records the full requirement-id sets before and after the change. Record identity is already a column, and bookkeeping timestamps (`created_at`, `updated_at`) describe the write rather than the change. Domain timestamps such as `occurred_at` and `attested_at` remain part of the audit payload. An update that changes nothing writes no event at all.

History is readable at `GET /api/v1/organizations/{organizationId}/history`, newest first and paged like every other collection ([ADR 0006](adr/0006-cursor-paged-collections.md)). `?resource={id}` narrows it to one record, named by its identifier alone since the identifier says what kind it is. There is no per-record route and no 404: history outlives what it describes, so there is nothing to look a resource up in, and what a caller may see is decided by the policies ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)).

**The table is append-only to the application.** Row-level security grants a tenant `SELECT` and `INSERT` and names no other command, so no code path can rewrite or erase an event through its tenant context. `TRUNCATE` and the privileges of the role that owns the table are outside row security, so preventing the runtime role from rewriting or erasing history also requires restricted privileges — see [deployment](deployment.md). Deleting an organization still removes its history, through the foreign key's cascade.

### Changing only what you read

Amending or deleting a control or evidence record accepts `If-Match`, and answers `412` when the version it names has moved ([ADR 0019](adr/0019-conditional-writes.md)). A record's version is PostgreSQL's `xmin` — the transaction that last wrote the row — served as an `ETag` on individual control and evidence reads and successful amendments, so a client can make a second edit without reading again. Recording evidence answers with its first tag too, so what was just recorded can be attested without reading it back.

The header is optional for those operations: omitting it leaves writes last-writer-wins. Attesting evidence requires the exact `ETag` from the evidence read.

`PUT /controls/{controlId}/requirements` replaces a set of rows rather than amending a record, so there is no single row version to quote. Its version is the set's contents instead, served as an `ETag` when the requirements are listed — the same on every page of them — and honoured on the replacement. A control therefore carries two versions, its own and its mappings', and they are not interchangeable. A client that reads the set page by page and writes it back needs the same tag on every page, and reads again if one differs: a mapping added behind its cursor changes the tag on later pages without appearing in them.

### Not implemented yet

Documents, risks, audits, findings, incidents, CAPAs, training, suppliers, approvals, and workflows. They join the same package and the same migration history.
