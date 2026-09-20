# Deployment

How to install, configure, and upgrade Quality Runtime, and which deployment targets are currently supported.

No deployment target is supported yet. Docker is the canonical self-hosted target, and Cloudflare Workers is a design target; this document records their status as each becomes real.

## What a deployment provides

Quality Runtime needs PostgreSQL and an S3-compatible bucket, and nothing else:

| Setting                     | Holds                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | The database, as a role that owns nothing and has neither `SUPERUSER` nor `BYPASSRLS` |
| `STORAGE_BUCKET`            | The bucket file bytes are kept in                                                     |
| `STORAGE_REGION`            | Its region — `auto` for Cloudflare R2, the real one for AWS S3 and Backblaze B2       |
| `STORAGE_ACCESS_KEY_ID`     | A key pair scoped to that bucket                                                      |
| `STORAGE_SECRET_ACCESS_KEY` | The other half of it                                                                  |
| `BETTER_AUTH_URL`           | The public origin the server is reached at                                            |
| `BETTER_AUTH_SECRET`        | At least 32 high-entropy characters                                                   |

The server refuses to start without any of them, and refuses to start if the bucket does not answer. `STORAGE_ENDPOINT` is the one optional setting: unset, AWS S3 itself is addressed by virtual host; set, it is the base URL of anything else speaking the same protocol — Cloudflare R2, MinIO, Backblaze B2. `MIGRATION_DATABASE_URL` is not one of these: migrations are a separate step with a role of their own, described under [Applying migrations](#applying-migrations).

Bytes go between the client and the bucket directly, with short-lived URLs this server signs; nothing uploads or downloads through the application ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)). PostgreSQL remains the authority on what a file is and who may read it, and the bucket holds only bytes, under keys the application derives from identifiers it issued.

### What the bucket needs

**Private.** Nothing is served from it except through a signed URL the runtime issues after resolving the file in the caller's tenant context. A bucket with public read turns every file identifier into a download link.

**A hostname of its own, in production.** A download answers `303` to the store, and a cookie is not kept off a host by a port — so a store sharing this server's hostname is one a browser may hand the session cookie to. `Path=/api` on the session cookie keeps it off a bucket answering below `/`, and the server refuses to start when `STORAGE_ENDPOINT` and `STORAGE_BUCKET` together put the bucket at this host's `/api` or below; neither makes a shared host a boundary ([security](security.md)). Same-host MinIO on another port is a development convenience, not a production pattern. A sibling hostname keeps the cookie confidential rather than making the store an untrusted origin, which is a distinction [security](security.md) draws.

**HTTPS, in production.** `BETTER_AUTH_URL` and `STORAGE_ENDPOINT` are both reached by a browser, and a presigned URL is a bearer credential carrying evidence. Use TLS for both; `http://localhost` is for development.

**A key pair scoped to it.** The runtime needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*`, and `s3:ListBucket` on the bucket itself. The last is what lets start-up tell a bucket that is missing from one that is empty, and what [`reclaim:storage`](#reclaiming-unclaimed-bytes) reads to find bytes no row claims; serving files needs neither.

**CORS, if a browser uploads.** A browser sending bytes to the bucket is a cross-origin request, so the bucket must allow `PUT` from the application's own origin and the `Content-Type` request header. Nothing else: the bucket stays private, and the URL is the authorization.

```json
[
  {
    "AllowedOrigins": ["https://quality.example.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3000
  }
]
```

The runtime never writes this, or any other bucket configuration. A bucket may be shared, and a product that rewrites bucket policy at start-up is one an operator cannot put anywhere.

**Room for what it will hold.** A file is at most 25 MiB and a piece of evidence carries at most twenty of them, so what `files/` grows to follows from how much evidence a deployment expects. Both limits are the runtime's, and `/api/v1/openapi.json` states the first of them as the API's own contract.

`uploads/` is not bounded that way. A presigned PUT is signed for a key and a method, not for a size, so a member can send far more than a file may be — the completion refuses it and the bytes are already there — and can prepare as many uploads as they like. A single upload is bounded by the provider's own PUT limit and by the fifteen minutes a URL lasts; the lifecycle rule below bounds how long abandoned bytes stay. Neither bounds how many a member may start, so what `uploads/` holds at once is bounded by the trust placed in members. Set the rule, and treat what `uploads/` may hold as bounded by the trust placed in members ([security](security.md)).

**A lifecycle rule on `uploads/`.** Prepared uploads that are never completed leave their bytes there. The runtime removes them when it can — on a completion, and on a refusal it knows to be final — but a client that walks away leaves bytes nothing will ever name. Expire objects under `uploads/` after a day and the question is closed. Objects under `files/` are the files themselves and must never be expired.

**Versioning and object lock, for a retention obligation.** The checksum on every `file` row makes a change to the bytes detectable; the bucket is what keeps the original recoverable after one. A deployment that must keep records for years should turn on versioning, and consider object lock in governance or compliance mode.

Know what that buys. Object lock protects a _version_, not a key: someone with write authority on the bucket can still make a newer version current, and Quality Runtime downloads by key. So the guarantee is that `verify:files` reports the mismatch and the locked original is still there to restore — not that the bytes served cannot change.

Scope it to `files/` if the provider lets you, and check before you turn it on: what the bucket holds under `uploads/` is temporary and must stay deletable. Cloudflare R2's bucket locks take a prefix, so `files/` can be locked on its own. AWS S3 and Backblaze B2 apply a bucket's _default_ retention to every new object version in it, `uploads/` included — so a long default retention there makes abandoned uploads undeletable for that period, and the lifecycle rule above cannot remove them. Both allow retention to be set per object instead, at the moment it is written; Quality Runtime does not do that for you, and will not until a deployment needs it. Until then, on those providers, either accept that `uploads/` is locked too or give it a bucket of its own.

Back the bucket up with the database, and at the same time. A file whose row is gone is unreachable; a row whose bytes are gone is a broken download — and for attested evidence, a record that has lost the thing it was evidence of. Nothing reconciles the two, so a restore that mixes eras leaves work for a person.

**Keeping records is the operator's job.** Quality Runtime does not expire evidence or enforce a retention schedule of its own. Attestation stops the application changing a record; it does not stop an organization being removed or a bucket being lost. So a deployment that must keep records for a period — the CRA, for one, has a manufacturer keep technical documentation for ten years after the product is placed on the market, or for its support period if longer (Art. 13(13)) — has to keep them, attachments included, for that long. Take a copy before removing an organization whose records must stay available; backups taken afterwards do not hold it. A backup never restored is an assumption. Restore one now and then, and point the check below at the restored copy, connecting as a role like the server's — it refuses one that bypasses row-level security:

```sh
DATABASE_URL=… STORAGE_BUCKET=… STORAGE_REGION=… \
  STORAGE_ACCESS_KEY_ID=… STORAGE_SECRET_ACCESS_KEY=… bun run verify:files
```

It checks only the files the restored rows name. On a database with none it says nothing was checked rather than that everything matched, but a restore missing some records passes all the same, so confirm that the records you expect are there, too.

Discarding evidence takes its `file` rows by cascade and leaves the bytes in the bucket, because a foreign key cannot reach one. The completion handler tidies after itself — it removes what it promoted when the row does not land, and removes the temporary object when it does — but nothing in a request can clean up after a cascade that happens later. Storage therefore grows with successful uploads even when their evidence is later discarded, until something reclaims it.

Two commands cover the two directions, and neither sees what the other does. `bun run verify:files` walks the rows and checks their bytes; it cannot see bytes no row claims. [`bun run reclaim:storage`](#reclaiming-unclaimed-bytes) lists the bucket and finds exactly those ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)).

## Database role

**The role in `DATABASE_URL` must not be a superuser and must not have `BYPASSRLS`.**

Tenant isolation is enforced by PostgreSQL row-level security ([ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md)). PostgreSQL exempts superusers and `BYPASSRLS` roles from every policy, so connecting as one — the `postgres` superuser that container images create by default, for instance — silently disables isolation across the whole database. Nothing fails, no error is logged, and every tenant can read every other tenant's data.

So the server checks at start-up and refuses to run when the role is exempt, when a domain table's row security is not both enabled and forced — the database was not migrated, or someone altered it — or when the connection has `row_security = off`, the migrator's setting.

The role must also own nothing. [Two roles](#two-roles) below provides the role creation and grant statements; [development](development.md#database) adapts them for the local PostgreSQL container.

To check the connection role directly:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
-- both must be false
```

### Two roles

**The role the server connects as must own nothing.**

`FORCE ROW LEVEL SECURITY` makes the policies apply to a table's owner, which is enough for tenant isolation ([ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md)). It is not enough for anything else: an owner can `TRUNCATE` a table, `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, or change the schema, and none of those is subject to a policy. A deployment whose server owns its tables has history and attestations that are protected from its code and from nothing else.

So there are two roles ([ADR 0014](adr/0014-the-runtime-role-owns-nothing.md)):

```sql
CREATE ROLE qualityruntime_migrator LOGIN PASSWORD '…';   -- owns the schema, applies migrations
CREATE ROLE qualityruntime LOGIN PASSWORD '…';            -- the server connects as this

-- The migrator owns the tables, and FORCE holds an owner to the policies, so a
-- statement with no tenant context would see no rows. Off makes that an error.
ALTER ROLE qualityruntime_migrator SET row_security = off;

-- drizzle-kit keeps its journal in a schema of its own, which it creates.
GRANT CREATE ON DATABASE qualityruntime TO qualityruntime_migrator;
GRANT CREATE, USAGE ON SCHEMA public TO qualityruntime_migrator;
GRANT USAGE ON SCHEMA public TO qualityruntime;

-- Every table the migrator creates from now on is readable and writable by the
-- server, without a grant per migration. Set before the first migration: this
-- is a rule for tables yet to be created, not a grant on the ones there are.
ALTER DEFAULT PRIVILEGES FOR ROLE qualityruntime_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qualityruntime;
```

Run this block as a superuser, and the `REVOKE` block below as a superuser too. `ALTER DEFAULT PRIVILEGES FOR ROLE` requires superuser or membership in the role it names; `REVOKE` requires ownership of each table, so superuser or membership in `qualityruntime_migrator`.

Getting that wrong is quiet. A `REVOKE` run by a role that merely belongs to the _grantee_ raises no error and removes nothing — PostgreSQL warns and moves on — so the block appears to have worked and the privilege is still held. Only a role with no claim at all gets a refusal.

All of this assumes a fresh database. On one whose tables already exist, the default privileges above cover nothing that is already there, so run `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qualityruntime;` once as well. It is deliberately not part of the block above — on a fresh database it would silently do nothing, and a statement that does nothing is one nobody can tell is wrong.

`MIGRATION_DATABASE_URL` is the migrator's; `DATABASE_URL` is the server's. Migrations are applied as a separate step, by a role the server never uses.

`row_security = off` does not bypass row security: it rejects queries subject to it, even when a tenant setting is present and matches every row. Schema changes are unaffected. A data migration that intentionally works within one tenant must enable row security for its transaction (`SET LOCAL row_security = on`) and set the transaction-local organization context before accessing domain rows. This applies the tenant policies; it does not grant cross-tenant access. The role default takes effect on login, so changing that default affects subsequent connections.

Then, once the tables exist, take back what no policy would ever allow anyway:

```sql
REVOKE UPDATE, DELETE ON "audit_event"          FROM qualityruntime;  -- append-only (ADR 0005)
REVOKE UPDATE, DELETE ON "file"                 FROM qualityruntime;  -- attached for good (ADR 0013)
REVOKE UPDATE         ON "control_requirement"  FROM qualityruntime;  -- a link is made or unmade (ADR 0010)
REVOKE UPDATE         ON "file_upload"          FROM qualityruntime;  -- see below (ADR 0021)
GRANT  UPDATE ("file_id") ON "file_upload"      TO   qualityruntime;
REVOKE DELETE         ON "organization"         FROM qualityruntime;  -- see below
```

`file_upload` keeps `DELETE`, and gets `UPDATE` back on one column. It is not a record but the state of an upload in flight, so unlike `file` the runtime has to be able to change it — once, to name the file it produced — and to reclaim it once it has expired. But that one column is the whole of it: which evidence an upload is for, what the file will be called, and when the window closes are settled when the upload is prepared, and the completion handler decides from the values it read before it spent minutes in the object store. A policy cannot express "these columns did not change", and a trigger to say so would be a trigger where a grant does. `SELECT … FOR UPDATE` needs the privilege on only one column, so the completion still takes its lock ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)).

The last one is different in kind. A foreign key's `ON DELETE cascade` is a referential action: it is subject to neither row-level security nor the privileges on the table it cascades into. Every tenant-owned table references `organization`, so `DELETE FROM "organization"` would take the audit log and every attestation with it, around the revokes above. Removing the privilege on the parent is what closes that, and the server offers no route that would do it.

Removing a tenant is therefore an operator's job, done deliberately as the migrator. That is the intent: it is not an action a customer's own administrator should be able to take through the API.

The others are not decoration either. Row-level security already makes such a statement match nothing; the revoke turns a silent no-op into a refusal, which is what a bug in this area deserves. `apps/server/privileges.test.ts` derives the list from the policies themselves, so a future table with no `UPDATE` policy fails the suite until its revoke is written here.

Nothing else is granted: the server holds no `TRUNCATE`, owns no table, and cannot change the schema.

`apps/server/documented-setup.test.ts` executes the two fenced blocks above, applies the migrations as the migrator, drives the product as the runtime role, and then asks PostgreSQL what that role ended up holding: its privileges on every table in every schema, what it may create, what roles it belongs to, and its role attributes. A block edited into something that does not work fails there, and so does one that hands the runtime role more than it should have. Keep them as two fenced `sql` blocks in this order; that is what the test reads, and SQL it cannot read is an error rather than a skip.

Two things it does not establish. It reaches the roles with `SET ROLE` on one session rather than by connecting, so `LOGIN` is checked as an attribute, while passwords and actual login are not tested. And the one-off grant for an existing database is not executed, because on the fresh database the test builds it would do nothing — which is exactly why it is not in a block.

What survives are PostgreSQL's own defaults, which neither block revokes: the role can create temporary tables, and it can create large objects, which sit outside row-level security entirely. Nothing here uses either. `REVOKE TEMP ON DATABASE … FROM PUBLIC` takes away the first; it does not touch the second, for which PostgreSQL offers no privilege to revoke — `lo_compat_privileges` and the large object's own ownership are the only levers, and neither is worth pulling for a feature nothing uses.

## Checking stored files

```sh
bun run verify:files
```

Reads every file recorded in PostgreSQL, recomputes its checksum, and reports altered, missing, or unreadable files. Unreferenced bytes on disk are not checked. Exits non-zero when it finds something, so a scheduled run does not need its output read — except to notice a run that found no files to check, which exits zero, because a new deployment holds none.

It reads every referenced file in full, so schedule it according to storage size and workload. Investigate findings before restoring: a checksum mismatch indicates changed bytes, while missing or unreadable files can also indicate the wrong bucket, the wrong endpoint, or a key pair that has lost its permissions ([ADR 0016](adr/0016-verifying-stored-bytes.md)).

A file reads as missing when the bucket has no object under its key, and as unreadable when there is something there and reading it failed. A missing finding therefore does not by itself establish deletion.

Verification reads each organization's file rows before checking their bytes; it is not a deployment-wide snapshot. Uploads committed after those reads require another run.

## Reclaiming unclaimed bytes

```sh
bun run reclaim:storage            # report
bun run reclaim:storage --remove   # and act on it
```

The other direction: bytes in the bucket that no row claims. Two things leave them — uploads that were prepared and abandoned, and files whose rows later went with a cascade, because discarding evidence takes its `file` rows and a foreign key cannot reach a bucket.

**It reports by default.** `--remove` is what deletes anything, and it is a separate word on purpose: this is the only thing in the product that can destroy evidence bytes. A report that found something exits non-zero, so a scheduled run is noticed; a run that removed what it found exits zero.

**On a versioned bucket it frees no space by itself.** A `DELETE` against a versioned bucket writes a delete marker: the key stops resolving, the versions stay, and the bill does not move. So the report says _removed_, not _reclaimed_. If you want the space back, the bucket needs a `NoncurrentVersionExpiration` rule and expired-delete-marker cleanup, with a retention long enough for whatever obligation the versioning was turned on for. That applies to `uploads/` — where nothing is ever worth keeping — and to `files/` whose evidence has been discarded, if those are genuinely free to go.

**Point it at this deployment's own database, and at a bucket no other Quality Runtime deployment writes to.** That is a precondition rather than a preference, and it is the operator's to meet. Ownership is decided negatively — an object that no row claims is an orphan — so a database that is not this one's makes live objects look unclaimed, and so does a second deployment keeping its files under `files/` in the same bucket. The key-shape test below does not help with the second: those keys really are this product's. Other content in the bucket is safe; another Quality Runtime deployment's files are not.

Within that, it is built to be wrong safely rather than to be thorough:

- it leaves alone any object written in the last day, so bytes promoted while a completion is still committing are never mistaken for an orphan;
- it touches only keys shaped like ones this product issued, so other content in the same bucket is left alone;
- it reads every organization's rows inside that organization's own context, and refuses to run as a role that bypasses row-level security — one that did would read the wrong set of rows, which here means deleting the right ones;
- and it refuses outright, removing nothing, when the database holds no files at all. That catches an empty database, and a restore that never loaded — but only the case where _nothing_ is recorded. A database with a handful of files in it passes, so the refusal is a backstop and not the precondition above.

A deployment whose last recorded file has been discarded cannot use `--remove` at all: with no files in the database, the refusal above cannot tell that state from a database that is not this one's, and it declines. Permanent orphans then wait for positive deployment identity, which this does not yet have.

An expired upload's record is removed a day after its window closed, along with its bytes — but only by `--remove`. A deployment that leaves abandoned bytes to a bucket lifecycle rule and never runs the destructive mode keeps those rows, which are small and tenant-scoped but unbounded. Pruning them without touching a single object is a maintenance job this does not yet offer. The delay is so that a completion whose window ran out mid-flight is told the window closed rather than that its upload never existed; it is refused either way. A completed upload's record is kept however old it is — that row is what makes completing an upload idempotent, and removing it would let a client retrying a lost response attach a second file.

A bucket lifecycle rule expiring `uploads/` remains worth having even with this: it bounds abandoned uploads without anything needing to run.

Nothing records findings anywhere durable yet. Keep the output.

## The API reference

`/api/v1/reference` renders the OpenAPI document for a person to read. The browser loads its JavaScript from a CDN ([ADR 0015](adr/0015-a-rendered-api-reference.md)). If users' browsers cannot reach the CDN, set `API_REFERENCE_BUNDLE_URL` to a browser-accessible URL hosting your own copy of `@scalar/api-reference`. The server does not fetch this bundle; `/api/v1/openapi.json` is unaffected.

## Upgrading from the mounted-volume design

File bytes used to live in a directory named by `STORAGE_DIRECTORY`, and now live in a bucket ([ADR 0021](adr/0021-file-bytes-in-object-storage.md)). There is no migration between the two, and none is offered: no deployment target is supported yet, so there is nothing yet promised to anybody.

An installation from before the change does not fail loudly, which is the part worth knowing. The bucket is configured and answers, so the server starts; the `file` rows are still there, so evidence still lists its attachments; and every download of one is a redirect to an object that was never written. `bun run verify:files` reports every one of them as missing, and — because that is also what the wrong bucket looks like — points at the `STORAGE_*` settings, which in this one case is the wrong place to look.

Start fresh if you can. If you cannot, remove the `file` rows as the migrator, since the runtime role has no `DELETE` on that table by design:

```sql
DELETE FROM "file";
```

Their bytes are still on the old volume, which is the only copy. Take it before removing anything, and re-upload what matters through the API — the evidence records themselves are untouched by this, so the attachments go back onto the records they were always on.

## Applying migrations

```sh
MIGRATION_DATABASE_URL=… bun run db:migrate
```

Run it as a step of its own before starting the server, not from the server: several instances starting at once would each try, and the role that applies migrations is deliberately not the one the server has.
