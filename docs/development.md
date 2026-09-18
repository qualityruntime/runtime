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

`.env` is ignored, as are `.env.local` and `.env.*.local`. Mode-specific `.env.<mode>` files are **not** ignored; never put secrets in one.

Change a table in `packages/db/schema/`, then generate and apply its migration:

```sh
bun run db:generate --name=add_controls   # writes packages/db/migrations/NNNN_add_controls.sql
bun run db:migrate                        # applies pending migrations as MIGRATION_DATABASE_URL
```

Both are also `bun run generate` / `bun run migrate` inside `packages/db`; the Drizzle config loads the root `.env` either way. `db:generate` needs no database; `db:migrate` connects as `MIGRATION_DATABASE_URL` and fails if it is unset, never falling back to `DATABASE_URL`.

Always pass `--name`: it names the file and its `tag` in `migrations/meta/_journal.json` together. That file is drizzle-kit's, so never hand-edit it. Add the SPDX header to the generated `.sql`. Never edit a migration that may already have been applied; add a new one. See `AGENTS.md` for the rules that govern migration history, and test migrations against realistic existing data when the change is non-trivial.

`packages/db/schema/migrations.test.ts` applies the migrations to PostgreSQL (via PGlite, so nothing needs to be running) and checks the constraints they create. `apps/server/auth.test.ts` checks structural compatibility with Better Auth and exercises selected Better Auth writes against that migrated schema.

After upgrading `better-auth`, run `bun run test`, then compare `packages/db/schema/auth.ts` against Drizzle reference output from the matching `auth` CLI version, generated from `authOptions` by a module exporting a built `auth` instance. Neither test compares column types, indexes, or foreign keys against the library — [ADR 0001](adr/0001-drizzle-orm-and-better-auth.md) records that gap.

## Running the server

```sh
bun run dev   # http://localhost:3000, restarting on change
```

It runs from the repository root so Bun loads the root `.env`, and it refuses to start when `DATABASE_URL`, `BETTER_AUTH_URL`, or `BETTER_AUTH_SECRET` is missing rather than failing on the first request that needs one.

`apps/server` mounts [Better Auth](https://better-auth.com) at `/api/auth/*`. `authOptions` in `apps/server/auth.ts` is the schema contract — it decides which tables exist, and `auth.test.ts` derives its expectations from that same object. Better Auth refuses to start when the Drizzle schema object disagrees with it; that check reads the schema in code, not the live database, so applying migrations is still on you.

## Before finishing

Run `bun run check` and `bun run test`, plus the REUSE lint. CI runs `check` and `test`; the REUSE lint has its own workflow.

For REUSE validation on macOS:

```sh
uvx --from 'reuse[charset-normalizer]' reuse lint
```

Do not add tools, services, packages, or abstractions solely to satisfy a hypothetical future requirement.

For repository-wide engineering rules, see [`../AGENTS.md`](../AGENTS.md). For architectural constraints, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
