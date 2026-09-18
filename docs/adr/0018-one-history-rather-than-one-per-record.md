<!--
SPDX-FileCopyrightText: 2026 Quality Runtime contributors
SPDX-License-Identifier: Apache-2.0
-->

# 18. One history, rather than one per record

## Status

Accepted. Replaces the `GET /controls/{controlId}/history` route introduced with [ADR 0005](0005-audit-history.md).

## Context

Audit history was readable in one place: `GET /controls/{controlId}/history`. That route looked the control up first and answered 404 when it was not there, so that a control in another organization was an absence rather than an empty list.

[ADR 0017](0017-discarding-a-draft-control.md) then made a control removable. The history of a discarded control is exactly the history someone would want — what was it, who made it, who threw it away — and it became reachable by nothing. `audit_event.resource_id` is a plain column rather than a reference precisely so that history outlives the record it describes, and the only route to it required the record to still exist.

Evidence had no history route at all, so the `deleted` event naming the files that went with a discarded piece of evidence — the only record those bytes leave behind — was unreachable too.

The obvious repair is a history route per entity. That is three routes today and one per entity forever, each duplicating the same paging, each with its own visibility rule, and none of them able to answer _what has happened here lately_.

## Decision

**One collection: `GET /api/v1/organizations/{organizationId}/history`.** Newest first, paged like every other collection ([ADR 0006](0006-cursor-paged-collections.md)), and narrowed to one record with `?resource=<id>`.

**The filter takes an identifier, not a type and an id.** An identifier here says what it is ([ADR 0002](0002-prefixed-identifiers.md)), so `?resource=ctl_…` is unambiguous, and the handler derives `resource_type` from the prefix. That derivation is not cosmetic: the index serving this starts with `(organization_id, resource_type, resource_id)`, followed by `(created_at, id)`. Supplying all three equality conditions lets it serve the requested order without a separate sort.

**There is no record lookup, and so no 404 for a record.** History outlives records, so there is nothing reliable to look a resource up in — the whole point of the change. A control discarded an hour ago still answers with everything that happened to it, including its own deletion; that is the case the change exists for.

What returns an empty page is a resource this organization has no history of: one that never existed, or one belonging to someone else. Those two are indistinguishable, and should be — row-level security decides what is visible, and there is nothing to tell apart. The old route's 404 was helpfulness rather than a boundary; it concealed nothing, since an out-of-tenant control produced an empty list either way.

The organization is still resolved before the handler runs, so a caller who is not a member gets 404 as they do from every other collection ([ADR 0004](0004-organization-in-the-request-path.md)). Removing the record lookup removed record-level absences, not that one.

**The resource is named in each event.** The per-control route left `resource_type` and `resource_id` out because the URL had already said them. A collection spanning records has to carry them, so the response shape gained both.

**A cursor cannot cross between filters.** A cursor is a position in an ordering, and narrowing the history makes a different ordering — the same position names different rows. The collection name carries the filter (`history` versus `history/ctl_…`), which is the mechanism ADR 0006 already uses to keep one collection's cursors out of another's.

The `resource` parameter is therefore read _before_ the cursor is validated. Validating in the other order would check a filtered cursor against the unfiltered ordering and refuse every page after the first.

## Consequences

**The whole organization's history is readable by any member.** That is a widening: previously a member could read one control's history at a time, and could not read evidence or standards history at all. It follows the rule the rest of the product already has — membership is the domain API boundary, and its handlers do not restrict actions by `member.role` ([ADR 0004](0004-organization-in-the-request-path.md)) — but it is worth stating rather than arriving at by accident. History carries actor labels, impersonation attribution, and the `before`/`after` of every change, including records since deleted. A product that wanted an audit-reader role would put it here first.

**A new index.** `(organization_id, created_at, id)`, because the existing one places `resource_id` between the type and the ordering key: a page of everything would otherwise be a sort of everything.

**The filtered query's use of its index is not verified.** Deriving `resource_type` is what keeps the narrowed read on `audit_event_resource_idx`, and nothing asserts that it does — an `EXPLAIN` on a table of a few dozen rows will sequential-scan whatever indexes exist, so the assertion would pass or fail for the wrong reason. Removing the derivation would leave every test green.

**Filtering stops here.** No `action`, no actor, no date range. Each wants an index or a scan, and none has a caller yet; `?resource=` earns its place because the alternative is history nobody can reach.

**No snapshot across pages.** Each page reads the history visible to its query. Newly visible rows ahead of the cursor are not included in the remaining pages; rows committed later with ordering keys behind it may be included. The cursor prevents offsets from shifting, but does not provide an export complete as of a fixed instant ([ADR 0011](0011-reading-a-mapping-from-both-ends.md)).
