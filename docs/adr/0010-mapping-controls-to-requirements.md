# 10. Mapping controls to requirements

Date: 2026-09-18

## Status

Accepted

## Context

Controls exist. Standards and their requirements exist. Neither means very much alone: a control answering to nothing is a measure with no reason, and a requirement no control answers to is an obligation nobody has taken up. The join between them is what `requirement → control → evidence` has been building towards, and it is the first thing in this repository that lets the database say which obligations somebody has taken up.

## Decision

`control_requirement`, keyed by the pair, carrying only when the link was made.

**No surrogate identifier.** The pair _is_ the identity, and a second row for the same pair would say nothing the first does not. [ADR 0002](0002-prefixed-identifiers.md) already exempted a join table keyed by its foreign keys, and `schema/index.test.ts` enforces that exemption rather than assuming it.

**No metadata beyond `created_at`.** No rationale, no coverage strength, no "partially satisfies". Each would be a real thing to model and none has a use yet; a column added when something reads it is cheaper than one that turned out to mean the wrong thing. This is the same restraint `control` was built with, and the same reason.

**Both references are composite**, and both borrow one `organization_id` ([ADR 0008](0008-standards-and-requirements.md)). A link can only exist if the control and the requirement it names are in that same organization — not as a rule the application applies, but as a row PostgreSQL will not store. This is what "cross-tenant relationships must be impossible unless explicitly modelled" looks like when the relationship has two tenant-owned ends.

**Linking is not creating, so the API is `PUT`.** `PUT /controls/{controlId}/requirements` replaces the whole set:

```json
{ "requirementIds": ["req_…", "req_…"] }
```

This is a genuine trade rather than an obvious win. Link and unlink can each be idempotent too, and they are better for a client that knows about one requirement and nothing else: they leave the rest of the mapping alone by construction. What `PUT` buys is that "these are the requirements this control answers to" — which is what a person editing a control actually means — is one statement of intent, applied whole or not at all, rather than a diff the client computes and applies in some order. Sending it twice changes nothing, including the history.

The cost is last-writer-wins. Two people editing the same control a second apart do not corrupt anything — the writes serialise — but the second replaces the set the first stored, and a requirement the second editor never saw is removed without anything saying so. Locking prevents an inconsistent write; it cannot preserve an intent the request did not carry. A conditional write is the answer when that matters, and there is one. [ADR 0019](0019-conditional-writes.md) first left this route out — `If-Match` names the version of a row, and this replaces a set — and then gave the set a version of its own, computed from its contents. Listing a control's requirements serves that as an `ETag`, the same on every page of it, and a replacement quoting it is refused if the set has moved. A client that reads the set page by page and writes it back needs the same tag on every page, and reads again if one differs: a mapping added behind its cursor changes the tag on later pages without appearing in them. A client that wants the last writer not to win silently now has a way to ask.

It is a set, not a sequence. Order carries no meaning and a repeated identifier is one identifier.

**An unknown requirement is a 400 that names it.** The foreign key would refuse it anyway, but as a 500 — and it would refuse a requirement belonging to another organization identically, which is right, because the answer must not distinguish a requirement that is elsewhere from one that is nowhere. The check runs inside the same transaction as the write, so nothing is stored when part of the set is unknown.

Reading them inside the transaction is not enough. Under `read committed`, another transaction may delete a requirement — or the standard stating it — between the check and the insert, and the foreign key raises after all. So the check takes `for key share` on the rows it validated: it blocks a delete until this transaction commits, without blocking anyone else reading them. Locking the control with `for update` serialises competing writes to the same control, which is a different race and does nothing about this one.

**A mapping change is recorded on the control.** The link has no life of its own and no history worth reading separately, so `audit_event` gets one `updated` event against the control with the whole set before and after. Recording the difference instead would be smaller, but `before` and `after` mean "how it was" and "how it is" everywhere else, and a set is a value like any other. A request accepts at most 500 entries before duplicates are removed, bounding the set written through this API and its audit payload.

Changing one link in a set of four hundred therefore stores eight hundred identifiers to express it. Nothing is lost — the difference is derivable, and deriving it is the reader's job — but anything rendering this history should show what was added and removed rather than two long lists.

**Reading it back is `GET /controls/{controlId}/requirements`**, paged like every collection, ordered by the requirement's position in its own standard.

## Consequences

Requirements from different standards interleave in that listing, because a position is only meaningful within the standard that assigned it. Each row carries its `standardId`, which is what a client groups by. A cross-standard ordering would have to invent a rank for standards themselves, and nothing yet needs one.

The reverse question — _which controls answer to this requirement?_ — is the same table read the other way, and the index for it is already there. It had no route when this was written; [ADR 0011](0011-reading-a-mapping-from-both-ends.md) gave it one, along with the unmapped-requirements read described below.

Which requirements nobody has taken up was answerable but not answered when this was written: nothing reported which requirements of a standard have no control, which is the question a quality manager actually asks. [ADR 0011](0011-reading-a-mapping-from-both-ends.md) answered it with `?mapped=false`. The filter narrows the existing standard-requirements collection by checking for mappings; it does not add a separate route.

Deleting a standard deletes its requirements, which deletes the links to them — a control simply stops answering to what is gone, silently. That is the right database behaviour and an uncomfortable product one: a control can lose its reason without anything being recorded, because the cascade is not a change the application made. Audit history for cascaded deletion is a real gap, recorded here rather than solved.

Neither lock could be exercised when this was written: PGlite has one connection, so no interleaving was reachable and the tests could only assert that a lock was _taken_. [ADR 0020](0020-testing-races.md) changed that. A conditional remapping is now run against a competing transaction holding the control's lock, and refused after release. The other direction is exercised too, although no route deletes a requirement or a standard: a replacement naming a requirement whose standard is being deleted waits for the deletion and answers 400, where a plain read would have passed the check and met the foreign key as a 500.

Importing a new edition of a standard leaves the old mappings exactly as they were, and creates none to the new edition's requirements. That is right — clauses that share a reference across editions are not the same requirement, and guessing they are would put a control's name against an obligation nobody checked — but it means adopting an edition is only half the work, and the remapping is manual with nothing to help. A tool for it is a real piece of work, and [ADR 0008](0008-standards-and-requirements.md) already noted that relating requirements across editions needs a table of its own.

A retired control can still be remapped. Retiring freezes nothing else on a control — its name and description stay editable, and history records each change — so freezing only its mappings would be a rule of its own. If retirement comes to freeze what a control meant, it should freeze the control and its mappings together.

`PUT` with an empty array clears the set, and is how a control is unlinked from everything. There is no `DELETE` on the collection, because it would mean the same thing twice.
