# Development

This document describes the local development workflow for Quality Runtime.

## Requirements

- Bun (the version pinned by `packageManager` in `package.json`)

The toolchain is [Vite+](https://viteplus.dev): formatting, linting, type checks, and tests behind the `vp` CLI, configured in `vite.config.ts`. The server itself runs under Bun.

## Setup

Install dependencies:

```sh
bun install
```

## Development

```sh
bun run check   # format, lint, and type checks
bun run fmt     # apply formatting
bun run lint    # lint only
bun run test    # run tests
```

## Editor

`.vscode/` carries the shared setup; VS Code offers the recommended extensions on first open.

- **[Vite+ extension pack](https://marketplace.visualstudio.com/items?itemName=VoidZero.vite-plus-extension-pack)** — formats with Oxfmt on save and lints with Oxlint, the same tools `bun run check` runs. The `[language]` overrides in `settings.json` are required: VS Code gives a user-level `[typescript]` formatter priority over a workspace default, so a global Prettier would otherwise take over and fight `vp fmt`.
- **[TypeScript 7](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview)** — required for type information in the editor. TypeScript 7 is the native compiler and ships no `tsserver.js`, so VS Code's built-in language service cannot run the workspace version; without this extension you get no types, no IntelliSense, and no inline errors.

## Database

PostgreSQL is the application database. The schema, the Drizzle client, and the migrations live in `packages/db`.

Copy `.env.example` to `.env` in the repository root, point `DATABASE_URL` at a database, and fill `BETTER_AUTH_SECRET` with `openssl rand -base64 32` (Better Auth only warns below 32 characters, so `createAuth` refuses to start):

```sh
docker run -d --name qualityruntime-postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=qualityruntime \
  -p 5432:5432 postgres:18
```

Then create the two roles a deployment uses, because local development should run the way production does ([ADR 0014](adr/0014-the-runtime-role-owns-nothing.md)). One owns the schema and applies migrations; the other is what the server connects as, and owns nothing:

```sh
docker exec -i qualityruntime-postgres psql -U postgres -d qualityruntime <<'SQL'
CREATE ROLE qualityruntime_migrator LOGIN PASSWORD 'qualityruntime';
CREATE ROLE qualityruntime LOGIN PASSWORD 'qualityruntime';
-- A query row security would filter fails, rather than matching nothing.
ALTER ROLE qualityruntime_migrator SET row_security = off;

GRANT CREATE, USAGE ON SCHEMA public TO qualityruntime_migrator;
GRANT USAGE ON SCHEMA public TO qualityruntime;
-- drizzle-kit keeps its migration journal in a schema of its own.
GRANT CREATE ON DATABASE qualityruntime TO qualityruntime_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE qualityruntime_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qualityruntime;
SQL
```

After the first `bun run db:migrate`, take back the privileges no policy would allow — as `postgres`, since revoking on a table needs ownership or superuser:

```sh
docker exec -i qualityruntime-postgres psql -U postgres -d qualityruntime <<'SQL'
REVOKE UPDATE, DELETE ON "audit_event"          FROM qualityruntime;
REVOKE UPDATE, DELETE ON "file"                 FROM qualityruntime;
REVOKE UPDATE         ON "control_requirement"  FROM qualityruntime;
-- Every tenant-owned table cascades from this one, and a cascade answers to
-- neither row-level security nor the privileges on what it cascades into.
REVOKE DELETE         ON "organization"         FROM qualityruntime;
SQL
```

Neither role may be a superuser or hold `BYPASSRLS`: PostgreSQL exempts both from the policies that isolate tenants, and the server refuses to start as one. `docs/deployment.md` explains why the separation matters. `apps/server/documented-setup.test.ts` runs both blocks above exactly as they appear and then drives the product on what they produced, so keep them as shell blocks wrapping a `<<'SQL'` heredoc — that is what it reads.

`.env` is ignored, as are `.env.local` and `.env.*.local`. Mode-specific `.env.<mode>` files are **not** ignored; never put secrets in one.

Change a table in `packages/db/schema/`, then generate and apply its migration:

```sh
bun run db:generate --name=add_controls   # writes packages/db/migrations/NNNN_add_controls.sql
bun run db:migrate                        # applies pending migrations as the migrator
```

`db:migrate` connects as `MIGRATION_DATABASE_URL` and fails if it is unset or empty. It never falls back to `DATABASE_URL`: that is the role that owns nothing, and a migration run as anything but the migrator loses the `row_security = off` guard above. `.env.example` has it.

Both are also `bun run generate` / `bun run migrate` inside `packages/db`; the Drizzle config loads the root `.env` either way. `db:generate` needs no database.

For a change drizzle-kit cannot express — row-level security policies, backfills, anything hand-written — generate an empty migration instead and write the SQL yourself:

```sh
bun run db:generate -- --custom --name=control_tenant_isolation
```

Always pass `--name`: it names the file and its `tag` in `migrations/meta/_journal.json` together. That file is drizzle-kit's, so never hand-edit it — `--custom` is how a hand-written migration gets its entry. Add the SPDX header to the generated `.sql`. Never edit a migration that may already have been applied; add a new one. See `AGENTS.md` for the rules that govern migration history, and test migrations against realistic existing data when the change is non-trivial.

`packages/db/schema/migrations.test.ts` applies the migrations to PostgreSQL (via PGlite, so nothing needs to be running) and checks the constraints they create. `packages/db/enforcement.test.ts` does the same for tenant isolation and every rule PostgreSQL keeps on its own, acting as a non-superuser role — PGlite's default connection is a superuser, and PostgreSQL exempts superusers from row-level security, so a test written against it would pass with the policies deleted ([ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md)). `apps/server/auth.test.ts` checks structural compatibility with Better Auth and exercises selected Better Auth writes against that migrated schema.

After upgrading `better-auth`, run `bun run test`, then compare `packages/db/schema/auth.ts` against Drizzle reference output from the matching `auth` CLI version, generated from `authOptions` by a module exporting a built `auth` instance. Neither test compares column types, indexes, or foreign keys against the library — [ADR 0001](adr/0001-drizzle-orm-and-better-auth.md) records that gap.

## Running the server

```sh
mkdir -p .storage   # once: the server refuses to start without it
bun run dev         # http://localhost:3000, restarting on change
```

It runs from the repository root so Bun loads the root `.env`, and refuses to start when `DATABASE_URL`, `STORAGE_DIRECTORY`, `BETTER_AUTH_URL`, or `BETTER_AUTH_SECRET` is missing. `STORAGE_DIRECTORY` holds uploaded files; the git-ignored `.storage` directory is suitable for development. Startup checks that the directory exists, but does not verify that it is a mounted volume or writable. It deliberately does not create the directory, to avoid silently writing to local storage when an expected volume is absent ([ADR 0013](adr/0013-durable-storage.md)).

`apps/server` mounts [Better Auth](https://better-auth.com) at `/api/auth/*`, and this product's own API at `/api/v1`. Tenant-owned resources — controls, standards, requirements, evidence, and files — sit under `/api/v1/organizations/:organizationId` behind `organizationContext`, which resolves the caller's membership and binds `withOrganization` to that organization ([ADR 0004](adr/0004-organization-in-the-request-path.md)); a route mounted outside that prefix has no `withOrganization` on its context and fails rather than serving unscoped rows. `apps/server/organization.test.ts` and `controls.test.ts` drive the stack over HTTP as a non-superuser role, so the policies apply there too; request bodies and query strings are validated with [Zod](https://zod.dev) through `validation.ts`, which owns what a rejection looks like, and collections are paged by cursor through `pagination.ts`, each naming the ordering it is read in ([ADR 0006](adr/0006-cursor-paged-collections.md), [ADR 0009](adr/0009-importing-a-standard.md)). `responses.ts` defines shared response envelopes and builds errors; resource modules define their response schemas, and handlers build successful responses. `openapi.ts` combines those schemas with operation metadata into the document served at `/api/v1/openapi.json` ([ADR 0007](adr/0007-openapi-from-the-schemas.md)). Adding a route means adding its operation there too — `openapi.test.ts` derives what the app serves and fails until the two agree. A mutating handler also records what changed through `c.var.audit`, on the same transaction as the change ([ADR 0005](adr/0005-audit-history.md)); `audit.test.ts` covers that, including that the history cannot be rewritten. `authOptions` in `apps/server/auth.ts` is the schema contract — it decides which tables exist, and `auth.test.ts` derives its expectations from that same object. Better Auth refuses to start when the Drizzle schema object disagrees with it; that check reads the schema in code, not the live database, so applying migrations is still on you.

## Checking stored files

See [deployment](deployment.md#checking-stored-files) for `bun run verify:files`, its limits, and interpreting findings. `apps/server/integrity.ts` implements verification independently of HTTP; `verify-files.ts` supplies the database connection and storage adapter.

## Testing races

Most of the suite runs on PGlite, which uses a single connection and cannot exercise lock contention between transactions. `apps/server/concurrency.test.ts` is the exception. It needs a real server, and it is skipped unless `TEST_DATABASE_URL` names one:

```sh
docker exec qualityruntime-postgres createdb -U postgres qualityruntime_test
# then, in .env
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/qualityruntime_test
```

These commands use the PostgreSQL container from the setup above. For a local PostgreSQL installation, adjust the database creation command and connection URL.

It **wipes** that database on every run, so it refuses one whose name does not end in `_test`. The lock-race tests force the interleaving rather than hoping for it: a second session takes the row lock, the request is started and waits on it, the second session commits, and the request is released into a world that moved under it. A test that never blocked fails, so it cannot pass without exercising the intended race.

Add to it whenever a handler's correctness rests on a lock. [ADR 0020](adr/0020-testing-races.md) records why this suite exists and what it does not cover.

## Before finishing

Run `bun run check` and `bun run test`, plus the REUSE lint. CI runs `check` and `test`; the REUSE lint has its own workflow.

For REUSE validation on macOS:

```sh
uvx --from 'reuse[charset-normalizer]' reuse lint
```

Do not add tools, services, packages, or abstractions solely to satisfy a hypothetical future requirement.

For repository-wide engineering rules, see [`../AGENTS.md`](../AGENTS.md). For architectural constraints, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
