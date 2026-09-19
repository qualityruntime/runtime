# 6. Collections are paged by cursor

Date: 2026-09-18

## Status

Accepted

## Context

`GET /controls` returned every control an organization had. That was deliberate — paging belongs with the rest of a collection's contract rather than bolted on — but it does not survive contact with a real deployment, and audit history made it urgent: an audit log only grows, and it is the collection most likely to be read from a client that cannot hold it all.

Two collections now exist and a third is never far away, so this settles how all of them behave rather than how one does.

## Decision

Every `/api/v1` collection takes the same query and answers in the same shape:

```http
GET /api/v1/organizations/{organizationId}/controls?limit=25&cursor=Y29udHJvbHM6cmVjZW50fDIwMjYtMDktMThUMTA6MTE6MDAuMDAwMDAwWnxjdGxfMDAwMDAwMDAwMDAwMDAwMQ
```

```json
{ "data": [ … ], "nextCursor": "Y29udHJvbHM6cmVjZW50fDIwMjYtMDktMThUMTA6MDk6MDAuMDAwMDAwWnxjdGxfMDAwMDAwMDAwMDAwMDAwNA" }
```

`nextCursor` is null when the query finds no further row. Clients continue until it is null; a later page can still be empty if rows are deleted or stop matching a filter between requests. Paging is a live view, not a snapshot ([ADR 0011](0011-reading-a-mapping-from-both-ends.md)).

**A cursor, not an offset.** `LIMIT`/`OFFSET` is correct only against a collection that is not changing. These are ordered newest first and written to constantly: a row inserted ahead of the offset between requests shifts the next page back onto an already-read row; deleting one ahead of it can skip an unread row. For an audit log — where the whole point is that nothing is missed — that is disqualifying. A cursor names a position in an ordering rather than a count from the start, so concurrent inserts cannot move it.

**The order is fixed, and total.** `(created_at, id)` descending. The identifier is in the key not for display but because `created_at` alone is not unique — `control.created_at` defaults to `now()`, which is the transaction's start time, so rows written together share it — and a key with ties is a cursor that can repeat or skip a row.

**The cursor carries the timestamp as PostgreSQL holds it.** A `timestamptz` keeps microseconds; a JavaScript `Date` keeps milliseconds. Taking the ordering key through a `Date` silently rounds it down, so the cursor names a position up to 999µs _before_ the row it came from — and the rows in that gap are skipped, which is precisely the failure a cursor exists to prevent. The value is selected as text with `to_char(… at time zone 'UTC', …)` and compared back with an explicit `::timestamptz`, so nothing in the round trip loses precision. `to_char` against UTC rather than a bare `::text` cast, whose output depends on the session's `TimeZone` — a cursor must not mean something different to the next connection that reads it.

**Every part is validated against the shape this API issues.** A cursor reaches a query either way, so "decodes to three parts" is not enough: an identifier carrying a NUL, or a year outside what PostgreSQL can hold, would be a 500 for what is a bad request. The ordering must be this collection's, the timestamp must match the exact format `to_char` produces, the identifier must match the form `packages/db/id.ts` generates, and the encoding must be the canonical one — base64url decoding skips characters it cannot read, so junk appended to a real cursor would otherwise pass. This is shape, not provenance: a client can build a well-formed cursor itself, and that is fine for the reason below.

**The cursor is opaque.** It encodes `ordering|created_at|id`, base64url, and is documented as meaningful only against the same collection in the same order. It is not signed: a tampered cursor selects a different position, which is not an escalation — row-level security still scopes the query, and every position it could name is one the caller may already read. Making it unforgeable would protect nothing.

**A cursor that is not well formed is a 400.** It means the client sent something that cannot be a position in this collection, and serving page one instead would turn a client bug into silently wrong data.

**One more row than the page.** The query asks for `limit + 1`; if it comes back, there is a next page and the extra row is dropped. That answers "is there more" exactly, without a second query and without a count that would be stale before it was read.

An audit event is written out as an explicit shape rather than returned as its row, unlike a control. The row carries the organization, which the URL has already named, and the actor's four columns describe one thing and read better grouped. (The resource was in that list until [ADR 0018](0018-one-history-rather-than-one-per-record.md) made history a collection spanning records, at which point the URL stopped naming it.) It also keeps a column added to `audit_event` from becoming an API change by accident.

## Consequences

A client cannot jump to page five, and there is no total. Both are real costs and both are the point: a total is a lie the moment it is computed on a collection being written to, and an absolute page number means nothing in an ordering that shifts.

The order is not a client's to choose. Sorting by name, or oldest first, would each need their own cursor encoding, because the cursor _is_ the ordering key. When a collection needs that, the cursor gains the key it sorts by and clients that treated it as opaque keep working — which is why it is opaque. A standard's requirements were the first to need it, and [ADR 0009](0009-importing-a-standard.md) records how an ordering became a value rather than a constant.

Filtering was not part of the initial implementation. A filter composes with this cleanly: it narrows the rows, the ordering key is unchanged, and the cursor still names a position. `?status=active` can be added to controls without revisiting any of this. History binds its cursor name to `?resource=` to prevent reusing a cursor across different records' histories ([ADR 0018](0018-one-history-rather-than-one-per-record.md)). This is a collection-specific choice: a standard's `mapped` and `reference` filters retain the same ordering and cursor name, so cursors can be reused across those filters ([ADR 0011](0011-reading-a-mapping-from-both-ends.md)).

> **Superseded by [ADR 0018](0018-one-history-rather-than-one-per-record.md).** `GET /controls/{controlId}/history` checked the control was visible before reading its history, and answered 404 when it was not. That is now one organization-wide collection with no record lookup: audit rows outlive the records they describe, which is exactly why requiring the record to still exist was wrong. The empty list this paragraph worried about conceals nothing — an out-of-tenant control produced one either way.

The ordering key is in the index, not just in the query. `control` is indexed on `(organization_id, created_at, id)`. For history, `(organization_id, resource_type, resource_id, created_at, id)` supports reads for one resource; [ADR 0018](0018-one-history-rather-than-one-per-record.md) added `(organization_id, created_at, id)` for organization-wide reads (see [`0000_schema.sql`](../../packages/db/migrations/0000_schema.sql)). These indexes allow backward scans in the requested order, though the query planner chooses the execution plan. Future filters and orderings need the same consideration: a small page can still require scanning or sorting many rows when an index cannot supply it.

The limit is capped at 100 and defaults to 25. The cap is what stops a page being a denial of service; the default is a guess, and the kind that is easy to change once something reads these collections in anger.
