# 1. Drizzle ORM for persistence, Better Auth for authentication

Date: 2026-09-18

## Status

Accepted

## Context

The runtime needs database access and authentication before any domain work can start. PostgreSQL is already a committed choice (DATA-01), and tenant isolation is an invariant (TENANT-01), so the organization concept has to exist in the schema from the first migration rather than be retrofitted around it.

Authentication is a large surface — sessions, credentials, social providers, email verification, MFA, invitations — and building it is not what makes this product valuable.

## Decision

Use **Drizzle ORM** for schema definition, queries, and migrations, and **Better Auth** for authentication, tenancy, and instance administration.

Drizzle's schema is plain TypeScript that compiles to SQL we can read in review, and `drizzle-kit generate` produces checked-in, forward-only SQL migrations (MIGRATION-01). It stays close to SQL, so the PostgreSQL capabilities the architecture leans on remain reachable.

Better Auth ships the tenancy model the product needs in its `organization` plugin, so organizations, memberships, and invitations are one source of truth rather than a parallel model beside the auth library's own. The schema supports these plugins; application authentication is not implemented yet:

| Plugin         | Why                                                                   |
| -------------- | --------------------------------------------------------------------- |
| `organization` | The tenant boundary: organizations, memberships, invitations          |
| `admin`        | Instance operator actions — roles, suspension, impersonation          |
| `twoFactor`    | MFA, a named control in the standards the product is built to support |

Teams and dynamic access control are deliberately off. Both add tables, and neither has a requirement behind it yet.

The Drizzle schema is written by hand rather than generated into the repository on every change. Two things keep it honest, and they cover different ground:

- Better Auth 1.7 runs the authoritative **structural** check when its adapter initializes, against the Drizzle schema object rather than the live database: every table and column it writes must exist, and no column it never fills may be required. It does not compare types, uniqueness, indexes, or references, and it does not prove equivalence with the generated DDL.
- `packages/db/schema/auth.test.ts` asserts the same structural properties from `getAuthTables`, plus an identifier format per model — before any application exists to initialize an adapter.

Nothing automatically verifies column types, uniqueness, indexes, or references against Better Auth's definitions. When upgrading, compare a reference schema generated from the matching Better Auth configuration with the maintained schema. `migrations.test.ts` exercises selected database-level deviations and invariants against a real engine; it does not verify every deviation.

Migrations are generated with `drizzle-kit` and applied with it during development. Deployment applies the same checked-in migration history by a target-appropriate mechanism.

## Consequences

Better Auth owns the shape of the `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, and `two_factor` tables. Changes to fields it writes must keep the Better Auth configuration, Drizzle schema, and new migrations aligned. Upgrades can add fields, and the schema test is what makes that visible.

How a deployed instance applies migrations is left open: a deployment may run them from its pipeline or use `drizzle-orm`'s migrator. That decision belongs in `docs/deployment.md` once a target exists. Development uses `drizzle-kit`; tests apply the same SQL history through Drizzle's PGlite migrator.

Deviations from Better Auth's generated schema are deliberate and documented in `auth.ts`: `timestamptz` columns, database defaults on `createdAt` and `updatedAt`, a unique membership per organization and user, a unique `(providerId, accountId)` per account, a foreign key on `session.activeOrganizationId`, and indexes on the foreign-key columns that parent deletion walks. These preserve the library’s required fields while adding database integrity checks and deletion support.

No Drizzle `relations()` are declared. They serve Better Auth's opt-in join mode and Drizzle's relational queries; neither is in use. Add relations when one of those features needs them.

`createDatabase` takes a `pg` `Client` or `Pool` rather than a connection string. Connection lifecycle differs enough between a long-lived server and a Worker behind Hyperdrive that choosing one here would put a deployment concern in the core (ARCH-01); the deployment owns it and injects the result.

Domain tables join the same package and the same migration history. `packages/db` depends on `better-auth` only as a development dependency, for the schema test; the server configuration that calls `betterAuth()` will live with the application that serves it, and must both use the same schema-affecting plugin configuration the test declares — plugin options such as `teams` add tables — and pass `generateId` from [ADR 0002](0002-prefixed-identifiers.md):

```ts
betterAuth({
  plugins: [organization(), admin(), twoFactor()],
  advanced: { database: { generateId } },
});
```
