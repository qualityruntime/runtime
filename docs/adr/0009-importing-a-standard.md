# 9. A standard is imported, not authored

Date: 2026-09-18

## Status

Accepted

## Context

[ADR 0008](0008-standards-and-requirements.md) settled what a standard and a requirement are, and deliberately left the API out: entering ISO 9001 is not the same activity as creating a control, and assuming the same shape would have been the mistake.

It also predicted the harder half. [ADR 0006](0006-cursor-paged-collections.md) fixed every collection to `(created_at, id)` descending, and a standard's clauses are a document with an order of its own. That ADR said the cursor would gain the key it sorts by when a collection needed it. This is the collection.

## Decision

**A standard arrives whole.** `POST /standards` takes the standard and the requirements it states in one request, in one transaction. There is no way to create an empty standard and fill it, because a standard with no requirements states nothing, and a half-imported one is worse than none. A requirement's `position` is assigned from the order the clauses were sent in rather than supplied: a client with the clauses in order already knows it, and one without them in order would be guessing.

**Re-importing is a conflict, not a merge.** A second import of the same name and edition answers 409. Merging would have to decide what a clause missing from the second import means — removed from the standard, or absent from this file — and neither answer is safe to guess. The decision is the database's: the insert relies on the unique constraint rather than a look-up beforehand that two concurrent imports could both pass.

**One audit event per import.** What happened is that an organization imported a standard, not that three hundred clauses appeared. The event records the name, the edition and how many requirements came with it. Auditing each clause would bury every other event in the organization's history, and the clauses are not independently interesting until something changes one.

**How much a route may read is chosen before any of it is read.** One figure cannot serve every route: 64 KiB refuses a legitimate standard, and a standard's allowance would let every other route accept one. So `app.ts` picks the limit per request — 1 MiB for an import, 64 KiB for everything else.

Picking it there rather than on the route is not a stylistic choice. A limit declared on the import route is never reached, because the shared one runs first; and a generous limit in front of a strict one is simply the generous one, since a limiter with no `Content-Length` to go on buffers the stream before passing it down. Either arrangement leaves the strict bound decorative.

The number of requirements is capped separately at 2,000 — one bound on bytes, one on rows, because a small body can still carry a great many tiny clauses.

**Collections name their ordering, and a cursor carries it.** `Ordering` is now a value: a key column, the identifier that breaks its ties, a direction, and how the key is rendered into a cursor and read back. Two exist — `newestFirst` for a record of what has happened, `asStated` for a document with an order of its own — and a collection names itself in its cursors.

That name is the part worth explaining. A position in one ordering is meaningless in another, which is obvious; less obvious is that it is equally meaningless in a _different collection ordered the same way_. Controls and standards are both newest first, so a cursor from one would be accepted by the other and would silently answer a list of standards from a position in the controls. Naming the collection is what makes that a 400.

## Consequences

Requirements page in `position` order, which ties — clauses are not renumbered to insert one — so the ordering key is `(position, id)` and the index [ADR 0008](0008-standards-and-requirements.md) added carries both.

There is no way to change a standard once imported: no `PATCH`, no `DELETE`, no way to add a clause. That is not a claim that standards are immutable — the rows are ordinary and mutable, and the schema says so — only that nothing yet has a reason to write them. A correction to a published standard is a new edition; a correction to a typo is a real gap, and the shape it should take (edit the requirement, or re-import) is a decision for whoever needs it first.

A 1 MiB import of 2,000 clauses is parsed and validated in memory before a row is written. That is the cost of atomicity, and it is bounded by both limits above. A standard too large for one request would need a different mechanism — a staged import with its own identity — and nothing suggests one exists.

A duplicate clause reference is a bad request, not a constraint violation. The unique index would catch it, but as a 500 for what is plainly malformed input — so the import schema checks it after trimming, because `"1"` and `" 1 "` are the same reference.

`requirementCount` on a standard is a subquery, not a stored counter. It cannot disagree with the rows, and the index on `(organization_id, standard_id, position, id)` serves it. If listing standards ever becomes slow, that is the thing to measure first.
