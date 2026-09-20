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

File bytes live in an S3-compatible bucket rather than a directory ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)), so development runs one locally. MinIO is the smallest thing that speaks enough of the protocol:

```sh
docker run -d --name qualityruntime-storage -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=qualityruntime -e MINIO_ROOT_PASSWORD=qualityruntime \
  minio/minio server /data --console-address :9001

docker run --rm --network host --entrypoint sh minio/mc -c \
  "mc alias set local http://localhost:9000 qualityruntime qualityruntime \
   && mc mb --ignore-existing local/qualityruntime"
```

The client is a second image rather than `docker exec` into the first, because the server image is not guaranteed to carry one. The values match `.env.example`, and the console is at `http://localhost:9001` if you want to look at what the runtime wrote.

```sh
bun run dev   # http://localhost:3000, restarting on change
```

It runs from the repository root so Bun loads the root `.env`, and refuses to start when `DATABASE_URL`, any of the four required `STORAGE_*` settings, `BETTER_AUTH_URL`, or `BETTER_AUTH_SECRET` is missing. It also refuses to start when the bucket does not answer: a bucket that is not there is indistinguishable from every file having been deleted, and finding that out on the first download is worse than finding it out at start-up. It deliberately does not create the bucket — one the runtime made is one nobody has configured for retention, and bucket policy belongs to whoever owns the bucket.

None of this is needed to run the tests. `bun run test` starts nothing: the suite runs the same `objectStoreInS3` a deployment runs, against an S3 that answers in memory (`apps/server/s3-in-memory.ts`), so signing, preconditions and the server-side copy are all exercised without a container.

What that cannot prove is the other half of the conversation: a signature is only correct if a real server agrees, and `x-amz-copy-source-if-match` is a promise a provider either keeps or does not. `apps/server/storage-integration.test.ts` asks the same contract of a real store, skipped unless `TEST_STORAGE_ENDPOINT` names one — the arrangement the concurrency suite has with `TEST_DATABASE_URL`.

Point it at something that speaks the whole subset, which is the trap: the lightweight S3 servers written for local testing mostly stop after `PutObject`, `GetObject` and presigning. This needs conditional `CopyObject`, `If-Match` on `GetObject`, `ListObjectsV2` with continuation tokens, and entity tags that survive all three. A store missing the conditional copy fails the suite outright, or — worse — accepts the copy, ignores the precondition, and passes while proving nothing.

```sh
TEST_STORAGE_ENDPOINT=http://localhost:9000 \
TEST_STORAGE_BUCKET=qualityruntime \
TEST_STORAGE_ACCESS_KEY_ID=qualityruntime \
TEST_STORAGE_SECRET_ACCESS_KEY=qualityruntime \
  bun run test
```

It wipes nothing: every key it touches is one it just created under an identifier of its own, and it removes them afterwards. CI runs it against MinIO, so a change that works only against the in-memory store does not pass.

`apps/server` mounts [Better Auth](https://better-auth.com) at `/api/auth/*`, and this product's own API at `/api/v1`. Tenant-owned resources — controls, standards, requirements, evidence, and files — sit under `/api/v1/organizations/:organizationId` behind `organizationContext`, which resolves the caller's membership and binds `withOrganization` to that organization ([ADR 0004](adr/0004-organization-in-the-request-path.md)); a route mounted outside that prefix has no `withOrganization` on its context and fails rather than serving unscoped rows. `apps/server/organization.test.ts` and `controls.test.ts` drive the stack over HTTP as a non-superuser role, so the policies apply there too; request bodies and query strings are validated with [Zod](https://zod.dev) through `validation.ts`, which owns what a rejection looks like, and collections are paged by cursor through `pagination.ts`, each naming the ordering it is read in ([ADR 0006](adr/0006-cursor-paged-collections.md), [ADR 0009](adr/0009-importing-a-standard.md)). `responses.ts` defines shared response envelopes and builds errors; resource modules define their response schemas, and handlers build successful responses. `openapi.ts` combines those schemas with operation metadata into the document served at `/api/v1/openapi.json` ([ADR 0007](adr/0007-openapi-from-the-schemas.md)). Adding a route means adding its operation there too — `openapi.test.ts` derives what the app serves and fails until the two agree. A mutating handler also records what changed through `c.var.audit`, on the same transaction as the change ([ADR 0005](adr/0005-audit-history.md)); `audit.test.ts` covers that, including that the history cannot be rewritten. `authOptions` in `apps/server/auth.ts` is the schema contract — it decides which tables exist, and `auth.test.ts` derives its expectations from that same object. Better Auth refuses to start when the Drizzle schema object disagrees with it; that check reads the schema in code, not the live database, so applying migrations is still on you.

## Attaching a file

Your bytes never pass through the API, so attaching one takes three requests ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)). This is the whole of it, against a server running as above, and it is the shape a CI job takes — an SBOM, a test report, a vulnerability scan — as much as a browser's. `$SESSION` is the cookie sign-in answered with, `$ORGANIZATION` the tenant you are acting in, and `$EVIDENCE` a record you have already created:

```sh
api=http://localhost:3000/api/v1/organizations/$ORGANIZATION
auth="cookie: $SESSION"

# 1. Ask. The runtime authorizes it and answers with somewhere to send bytes.
upload=$(curl -fsS "$api/evidence/$EVIDENCE/file-uploads" \
  -H "$auth" -H 'content-type: application/json' \
  -d '{"filename":"sbom.cdx.json","contentType":"application/json"}')

# 2. Send them, straight to the store. The URL carries its own authorization,
#    so this request has no session on it and never reaches the API.
curl -fsS --upload-file sbom.cdx.json "$(jq -r .data.upload.url <<<"$upload")"

# 3. Complete it. The runtime checks what the store actually holds and attaches
#    it, answering with the file. Safe to repeat.
curl -fsS -X PUT "$api/file-uploads/$(jq -r .data.id <<<"$upload")/completion" -H "$auth"
```

Three things are worth knowing before building on it:

**Step three is idempotent.** It is keyed on the upload identifier the first call answered with, which the client already holds. A pipeline that loses the response to step three and retries gets the same file back rather than attaching a second one — which is the property that makes this usable from CI at all.

**Nothing has to be computed in advance.** `contentType` is optional and `bytes` is optional; supplying `bytes` only buys a refusal before a URL is issued rather than after the upload. The size and the SHA-256 that end up on the record are the ones the server reads back from the store, never anything the client declared. A file may be up to 25 MiB and a piece of evidence may carry twenty of them — the published schema at `/api/v1/openapi.json` is where the first of those is stated for a client to read.

**Downloading is one request that redirects, and following it needs care.** The runtime resolves the file in your tenant and answers `303` to a URL good for a minute:

```sh
url=$(curl -fsS -o /dev/null -w '%{redirect_url}' "$api/files/$FILE" -H "$auth")
curl -fsS "$url" -o sbom.cdx.json
```

Two requests rather than `curl -L`, deliberately. `curl` re-sends a header given with `-H` to whatever host a redirect points at, so `-L` here would put your session cookie in the object store's access log — and the store is frequently somebody else's. The redirect target needs no session: the URL carries its own authorization, which is the same reason it is short-lived and not worth keeping. A browser is safe for a different reason than it looks — not because MinIO is another origin, but because the session cookie carries `Path=/api` ([security](security.md)).

## Checking stored files

See [deployment](deployment.md#checking-stored-files) for `bun run verify:files`, its limits, and interpreting findings, and [reclaiming unclaimed bytes](deployment.md#reclaiming-unclaimed-bytes) for `bun run reclaim:storage`. `apps/server/integrity.ts` and `reclaim.ts` implement the two directions independently of HTTP; `verify-files.ts` and `reclaim-storage.ts` supply the database connection and the object store.

`reclaim.ts` is the only code here that deletes evidence bytes, so `reclaim.test.ts` spends most of its length on what it must _not_ remove, and each of those guards is checked by deleting it and watching a test fail. That suite runs as a non-superuser role for the reason `enforcement.test.ts` does: a sweep that read only one tenant's rows would call every other tenant's files unclaimed, and against PGlite's superuser connection that bug is invisible.

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
