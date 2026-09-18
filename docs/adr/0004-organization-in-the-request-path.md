# 4. The organization is in the request path

Date: 2026-09-18

## Status

Accepted

## Context

Every tenant-owned resource belongs to exactly one organization, and [ADR 0003](0003-tenant-isolation-with-row-level-security.md) scopes database work to one organization per transaction. Something has to tell a request which organization it is acting in. This decides what, before any URL exists to be changed later.

Three candidates:

- **The session.** Better Auth's organization plugin already records `session.activeOrganizationId` and offers `setActive` to change it.
- **A header**, such as `X-Organization-Id`.
- **A path segment**, `/api/v1/organizations/{organizationId}/…`.

## Decision

The organization is a path segment. Every tenant-owned resource lives under `/api/v1/organizations/{organizationId}`:

```text
GET /api/v1/organizations/org_v1stgxr8z5jdhi6b/controls
```

`organizationContext` resolves that segment to the caller's `member` row before any handler runs, and hands the handler a `withOrganization` already bound to it. A handler cannot choose a different organization. Mounting a tenant-owned resource outside that prefix leaves its handler without `withOrganization` at all, so it fails loudly rather than serving unscoped rows; and were it to reach a tenant-owned table by some other route, ADR 0003 means an unscoped query returns nothing. Neither path leaks.

**The session was rejected on correctness.** `setActive` makes the organization ambient, mutable, and shared by every request that cookie makes. Two browser tabs in different organizations, or an agent working across several, race: a request's meaning depends on which `setActive` landed last, and the loser silently reads or writes in the wrong organization. Making the caller send `setActive` before each request is both a round trip and still racy. A request should mean the same thing whenever it is replayed.

`session.activeOrganizationId` keeps its existing job — remembering which organization a UI should offer by default. It remains context, never authorization (TENANT-01), and the routes never read it.

**A header was rejected on ergonomics, not correctness.** It is stateless and would work. But a URL that fully identifies the resource is easier to log, audit, bookmark, paste into a ticket, and — for the AI clients this product expects — construct and reason about without out-of-band knowledge. An omitted header also has no good failure mode: reject it and the header was mandatory anyway, fall back to the session and the ambiguity the session was rejected for is back.

A caller who is not a member of the organization gets **404, not 403**. A 403 confirms the organization exists, which turns a leaked or guessed identifier into a membership oracle. A non-member cannot distinguish an organization they cannot see from one that is not there — and `organization.id` is unguessable ([ADR 0002](0002-prefixed-identifiers.md)), so 404 costs a legitimate caller nothing.

Failures carry a machine-readable code:

```json
{ "error": { "code": "not_found", "message": "No such organization." } }
```

## Consequences

URLs are longer, and every tenant-owned route repeats the prefix. That is the price of a request that means one thing. Resources genuinely outside a tenant — instance administration, the signed-in user's own profile — do not take the prefix, and their absence from it is meaningful rather than an oversight.

The membership lookup is one indexed query per request, on `member_organization_id_user_id_uidx`. It is not cached: membership is the authorization decision, and a stale cache is a caller acting in an organization they have been removed from.

Authorization and isolation stay separate and are both exercised. `organizationContext` decides _whether_ the caller may act; row-level security decides _what_ they can touch once they may. `apps/server/organization.test.ts` runs the whole HTTP stack as a non-superuser role so both are real in the same test — the routes contain no `where organization_id`, and the rows come back scoped regardless.

The domain API resolves `member.role` onto the context but does not yet use it to restrict actions. Better Auth's organization-management routes enforce their own role permissions.

Should a tenant-owned resource ever need to be reachable without naming its organization — a short link, a webhook callback — it needs its own deliberate route that resolves the organization from the resource, not a relaxation of this one.
