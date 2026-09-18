# 3. Tenant isolation with row-level security

Date: 2026-09-18

## Status

Accepted

## Context

Tenant isolation is a system invariant (TENANT-01): tenant-owned data must not cross an organization boundary regardless of client behaviour. `control` is the first tenant-owned table, and the isolation model it establishes is the one every later domain table inherits — so it is worth getting right while exactly one table has to be retrofitted if it is wrong.

The ordinary approach is to write `where organization_id = …` in every query. It works until it doesn't: one forgotten predicate in one list endpoint leaks another tenant's records, code review is the only thing standing between the mistake and production, and a system that expects both people and AI agents to add domain code makes that a poor place to put the boundary.

PostgreSQL can enforce it instead. This decides whether it should, and what the application must do to make that enforcement real.

## Decision

Tenant isolation is enforced by PostgreSQL row-level security. Every tenant-owned table carries a policy comparing its `organization_id` to a transaction-local setting, `qualityruntime.organization_id`:

```sql
ALTER TABLE "control" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "control" FORCE ROW LEVEL SECURITY;

CREATE POLICY "control_tenant_isolation" ON "control"
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));
```

One function sets that context, and domain code reaches tenant-owned tables only through it:

```ts
const controls = await withOrganization(db, organizationId, (tx) => tx.select().from(control));
```

Four details carry the weight:

**`FORCE`, not just `ENABLE`.** PostgreSQL exempts a table's owner from its policies. A self-hosted deployment normally connects as the role that owns the schema, so `ENABLE` alone would produce a policy that is present, tested by the wrong role, and inert in production. `FORCE` removes the owner's exemption.

**Superusers are exempt regardless.** `FORCE` does not apply to a superuser or a `BYPASSRLS` role, and no statement in a migration can change that. The application must connect as neither; `docs/deployment.md` states this as a requirement, and it is the one part of this design the database cannot enforce on its own.

**A missing context denies rather than permits.** `current_setting(…, true)` returns NULL on a fresh connection and can return an empty string after a transaction-local setting expires. Neither matches an organization identifier, so a transaction without tenant context sees no rows and cannot insert any. The alternative failure — an unset context meaning "no filter" — is the one that leaks everything.

**`WITH CHECK` as well as `USING`.** `USING` governs what rows are visible to reads, updates, and deletes; `WITH CHECK` governs what a row may look like after an insert or update. For an `ALL` policy, PostgreSQL reuses `USING` when `WITH CHECK` is omitted. Both are written explicitly here to make the visibility and write constraints clear.

`withOrganization` opens a transaction and calls `set_config(name, value, true)` — `SET LOCAL` as a function, so the organization is a bound parameter rather than string-interpolated SQL, and PostgreSQL discards it when the transaction ends, including on rollback and before a pooled connection is reused.

This is **not** authorization, and it does not contain an authorization mistake. `withOrganization` scopes a request that has already been authorized; whether the caller may act in this organization is decided from their `member` row beforehand. Pass it an organization the caller does not belong to and the policy will faithfully scope to that organization — what the policy contains is a _missing_ tenant predicate or a _missing_ tenant context, not a wrong answer about who the caller is.

Nesting is refused for the same reason the design works at all. `SET LOCAL` is scoped to a transaction, not to a savepoint, so calling `withOrganization` inside a tenant context — which Drizzle would implement as a savepoint — leaves the inner organization in force after the savepoint is released, and the rest of the outer transaction runs as the wrong tenant. `withOrganization` throws when handed a transaction rather than trying to restore the previous value: code already inside a tenant context has the transaction it needs, and re-scoping one is not a thing the domain should want.

Better Auth's tables are deliberately excluded. It reads `member` and `invitation` to work out which organizations a user belongs to, which necessarily happens before any organization is known — a policy there would break sign-in, and those tables are reached through Better Auth's own authorization rather than domain queries.

The policies are hand-written SQL in [`packages/db/migrations/0001_tenancy_and_finality.sql`](../../packages/db/migrations/0001_tenancy_and_finality.sql) rather than declared with drizzle-kit's `pgPolicy` and `enableRLS`. drizzle-kit cannot express `FORCE`, so declaring part of the boundary in the schema would leave the load-bearing statement appended to the generated file by hand and absent from the snapshot, where a later regeneration could silently drop it. One readable SQL file is the safer shape for a security boundary; `drizzle-kit generate --custom` creates the file and its journal entry without diffing the schema.

## Consequences

A domain query that forgets its tenant predicate returns that organization's rows rather than every organization's. The predicate becomes a performance concern — the index on `organization_id` still matters — instead of a security one.

The application must connect to PostgreSQL as a non-superuser role without `BYPASSRLS`, which rules out the `postgres` superuser that container images create by default. Such roles bypass row security even when it is forced. `assertTenantIsolation` checks the runtime connection and refuses startup under either; migration credentials are configured separately.

Tests of policy enforcement must use a non-superuser role without `BYPASSRLS`; PGlite's default superuser bypasses the policies. `packages/db/enforcement.test.ts` creates such a role and makes it the owner of `control` to exercise `FORCE ROW LEVEL SECURITY`. That ownership is a test condition, not the recommended deployment setup: the runtime role should own no tables ([ADR 0014](0014-the-runtime-role-owns-nothing.md)). Separate cases verify startup refusal for an exempt role, for `row_security = off`, and for a table whose row security is not forced.

`packages/db/schema/migrations.test.ts` derives the list of tenant-owned tables from the schema and asserts that each has row-level security enabled, forced, and carrying a policy. A future domain table with an `organization_id` fails that test until it has one, so the protection is opt-out by accident rather than opt-in by memory.

At most one policy applies to a table for any one command, and every policy is permissive. Some tables have a single policy covering all four commands; others name each command separately, because what a tenant may do to a row depends on the row — `audit_event` grants no `UPDATE` or `DELETE` at all ([ADR 0005](0005-audit-history.md)), `evidence` and `file` refuse once attested ([ADR 0012](0012-evidence-and-attestation.md)), and `control` allows a delete only of one that was never in effect ([ADR 0017](0017-discarding-a-draft-control.md)).

One per command is the part that matters. Permissive policies are OR-ed together, so a _second_ policy for the same command would widen access rather than narrow it — which is the opposite of what anyone adding one usually intends. A future need for finer-grained access within a tenant should express it as a restrictive policy, or inside the policy already covering that command, rather than beside it.

Each `withOrganization` callback is one transaction, and a request may make several — the membership look-up that authorizes it happens outside any of them. So the unit of atomicity is the callback, not the request: writes that must succeed or fail together belong in **one** callback, not in two that happen to follow each other. Code that wants a connection with no tenant context says so by not calling `withOrganization` at all.
