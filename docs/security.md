# Security

The security model: trust boundaries, authentication, authorization, tenant isolation, file access, secrets, and AI and dependency security.

For vulnerability reporting, see [`.github/SECURITY.md`](../.github/SECURITY.md).

## Tenant authorization

A request names the organization it acts in **in its path** — `/api/v1/organizations/{organizationId}/…` — and `organizationContext` resolves that to the caller's `member` row before any handler runs ([ADR 0004](adr/0004-organization-in-the-request-path.md)). Membership, resolved per request, authorizes domain API access (TENANT-01); these handlers do not yet restrict actions by role. A caller who is not a member gets 404 rather than 403, so an identifier cannot be probed for membership.

`session.activeOrganizationId` is a different thing: the organization the user last selected, remembered so a UI can offer it again. It is **a preference, not a scope and not a permission** — the routes never read it, and nothing should treat possession of a session carrying an organization id as proof of access to that organization, or filter by it alone.

## Tenant isolation

Authorization decides whether a caller may act in an organization. Isolation makes the answer stick: once a request is scoped to an organization, the database will not let it read or write outside one.

The two are not interchangeable. Isolation contains a query that forgets its tenant predicate, and a code path that reaches a tenant-owned table with no tenant context at all. It does **not** second-guess the authorization decision — hand `withOrganization` an organization the caller has no membership in and it will faithfully scope to that organization. Resolving the caller's `member` row remains the thing that decides access.

PostgreSQL enforces it. Every tenant-owned table has row-level security enabled and forced, with a policy comparing `organization_id` to a transaction-local setting, and domain code reaches those tables only through `withOrganization`:

```ts
const controls = await withOrganization(db, organizationId, (tx) => tx.select().from(control));
```

A transaction with no organization set sees nothing and can write nothing, so forgetting the context fails closed. [ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md) records the design and its limits.

**The application must connect to PostgreSQL as a non-superuser role without `BYPASSRLS`.** PostgreSQL exempts both from every policy, and no migration can prevent it. The server checks at startup and refuses to run as either, with `row_security = off`, or when row security is not enabled and forced on every domain table. See [deployment](deployment.md).

Better Auth's tables are outside this: it resolves a user's memberships before any organization is known, so `member` and `invitation` carry no policy and are reached through Better Auth's own authorization.

`audit_event` is isolated the same way but narrower: its policies name `SELECT` and `INSERT` and nothing else, so a tenant can read and add to its history and no application code path can rewrite or erase it ([ADR 0005](adr/0005-audit-history.md)).

**Any member can read all of it.** `GET /history` serves the organization's whole audit history — actor labels, impersonation attribution, and the `before`/`after` of every change, including records since deleted ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)). Membership is the authorization boundary for the domain API; its handlers do not gate actions on `member.role`. Better Auth applies its own authorization to organization administration. That is a deliberate widening and the first place a reader-level role would be needed. Row security does not govern `TRUNCATE` or a table owner's privileges, so protecting the history from the runtime role itself is a matter of grants — see [deployment](deployment.md).

Three other tables name their commands rather than covering them all at once, and in each case the `DELETE` policy — or its absence — is where the rule lives. `evidence` admits only unattested rows, so what was signed cannot be removed ([ADR 0012](adr/0012-evidence-and-attestation.md)); `file` has no `DELETE` policy at all, and a trigger refuses an attachment to attested evidence. `control` admits only a draft, and a draft is held to be one that never took effect: a trigger owns `activated_at` and a CHECK ties a draft to its being null, so nothing that was in effect can become a draft again ([ADR 0017](adr/0017-discarding-a-draft-control.md)). Where a route reaches one of these, it answers with something a caller can act on; the policy is what makes the rule true.
