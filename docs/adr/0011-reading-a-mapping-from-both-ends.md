# 11. Reading a mapping from both ends

Date: 2026-09-18

## Status

Accepted

## Context

[ADR 0010](0010-mapping-controls-to-requirements.md) linked controls to requirements and read the mapping one way: the requirements a control answers to. It left the other direction unbuilt, and said why — a requirement was reachable only under its standard, and `/standards/{id}/requirements/{id}/controls` is not a URL anyone should have to type.

That URL is a symptom. The question behind it is whether a requirement is a thing in its own right or a part of a standard, and the mapping had already answered: a control names requirements by identifier, and following an identifier should not require knowing which standard stated it.

## Decision

**Requirements get a path of their own**, beside controls and standards rather than beneath them:

```text
GET /api/v1/organizations/{organizationId}/requirements/{requirementId}
GET /api/v1/organizations/{organizationId}/requirements/{requirementId}/controls
```

A requirement still belongs to exactly one standard, and `GET /standards/{id}/requirements` is still how you read a standard. What changes is that belonging to a standard is no longer the only way to reach one. `/standards/{id}/requirements` lists a document; `/requirements/{id}` identifies a thing.

The controls answering to a requirement are ordered newest first. Controls have no order of their own — nothing states them in a sequence the way a standard states its clauses — so they get the ordering every record of what has happened gets.

**And the first filter:** `GET /standards/{id}/requirements?mapped=false`.

This is the first request in the API that answers a question rather than reporting what is stored. _Which clauses of this standard has nobody taken up?_ is the thing a quality manager asks first, and until now it could only be computed by a client reading every requirement and every mapping.

**It is `mapped`, not `covered`.** A link says a control is _meant to address_ a requirement ([ADR 0010](0010-mapping-controls-to-requirements.md)). The filter asks whether any control is linked, regardless of whether it is draft, active, or retired. It makes no claim that the requirement is met or that evidence supports the mapping.

The filter is a `not exists` against the mapping, correlated on the requirement. [ADR 0006](0006-cursor-paged-collections.md) said a filter composes with a cursor without disturbing it — the filter narrows the rows, the ordering key is unchanged, and the cursor still names a position — and this is the case that shows it: a filtered page is walked with the same cursor as an unfiltered one.

**And a second: `?reference=`.** Engineers cite clauses by reference — `7.5.3`, `5.1-1` — in commits, pull requests and checklists, and a script linking a control to a cited clause needs the requirement it names. Without a filter that means reading the whole standard, up to 2,000 clauses, to find one.

`GET /standards/{id}/requirements?reference=7.5.3` narrows the collection to that requirement, or to nothing. It is a filter rather than a lookup route answering 404, for the same reasons `mapped` is one: it composes with the other filter and the cursor, keeps one shape for "requirements of this standard", and an empty page is an honest answer to "does this standard state 7.5.3?". The match is exact after trimming — the same normalisation the import applied — and case-sensitive, because [ADR 0008](0008-standards-and-requirements.md) makes the exact string the identity. `(standard_id, reference)` is unique, so the index enforcing that answers it too.

It stays inside one standard. The same reference means different things in different standards and editions, so a lookup across them would return several answers to what was asked as one question; a client names the edition it works to. One reference per request: this route reads the first of a repeated `reference`, not a list of them.

## Consequences

The subquery is inside the tenant context like every other read, so it counts only this organization's mappings. It has no `organization_id` predicate of its own and does not need one: it is correlated on the requirement, and a mapping can only name a requirement in its own organization, so another organization's mappings cannot reach it. The policies apply as well, and the index on `(organization_id, requirement_id, control_id)` serves it: the existence check stops at the first mapping rather than reading them all.

**`limit` bounds the rows returned, not the work done.** Finding a page of unmapped requirements may require examining all remaining requirements in the standard when few match. The work depends on where matches fall and the query plan; the page size alone does not bound it. Imports are capped at 2,000 clauses.

**A filtered walk is a live view, not a snapshot.** This is true of every collection here, and only noticeable once there is a filter. A requirement that someone maps while a client is walking `?mapped=false` leaves the walk before it is reached, which is right — it is no longer unmapped. One that is _unmapped_ behind the cursor does not reappear; it will be there on the next walk. A later page can come back empty for the same reason, and an empty page ends the walk rather than signalling a problem. Anything that needs a consistent picture of a moment — an export, a report someone signs — needs a snapshot, and nothing here offers one.

`mapped=true` keeps requirements with at least one mapping; omitting `mapped` includes requirements with and without mappings.

`GET /requirements/{id}` returns the requirement and nothing about its standard beyond `standardId`. A client rendering "clause 7.3 of ISO 9001:2015" needs a second request. Embedding the standard, or a `?expand=` of any kind, is a decision about the whole API rather than this route, and nothing is blocked on it.

Neither of the reverse reads is filtered. _Which requirements does this control answer to, among those of one standard?_ and _which controls answering to this requirement are active?_ are both reasonable and neither is asked yet.

What is still missing is the question one level up: how much of a standard is taken up, as a number rather than a list. That is a count, not a collection, and it does not fit the shape every route here has — which is worth noticing before inventing a route that pretends otherwise.
