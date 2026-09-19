# Deployment

How to install, configure, and upgrade Quality Runtime, and which deployment targets are currently supported.

No deployment target is supported yet. Docker is the canonical self-hosted target, and Cloudflare Workers is a design target; this document records their status as each becomes real.

## What a deployment provides

Quality Runtime needs PostgreSQL and a directory it can write to, and nothing else:

| Setting              | Holds                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | The database, as a role that owns nothing and has neither `SUPERUSER` nor `BYPASSRLS` |
| `STORAGE_DIRECTORY`  | Where uploaded files are kept                                                         |
| `BETTER_AUTH_URL`    | The public origin the server is reached at                                            |
| `BETTER_AUTH_SECRET` | At least 32 high-entropy characters                                                   |

The server refuses to start without any of them. `MIGRATION_DATABASE_URL` is not one: migrations are a separate step with a role of their own, described under [Applying migrations](#applying-migrations).

`STORAGE_DIRECTORY` must be on durable storage that outlives the process — a mounted volume, not a container's own filesystem and not `/tmp` ([ADR 0013](adr/0013-durable-storage.md)). PostgreSQL remains the authority on what a file is and who may read it; the directory holds only bytes, named by identifiers the database issued.

Back it up with the database, and at the same time. A file whose row is gone is unreachable; a row whose file is gone is a broken download — and for attested evidence, a record that has lost the thing it was evidence of. Nothing reconciles the two, so a restore that mixes eras leaves work for a person.

**Keeping records is the operator's job.** Quality Runtime does not expire evidence or enforce a retention schedule of its own. Attestation stops the application changing a record; it does not stop an organization being removed or a volume being lost. So a deployment that must keep records for a period — the CRA, for one, has a manufacturer keep technical documentation for ten years after the product is placed on the market, or for its support period if longer (Art. 13(13)) — has to keep them, attachments included, for that long. Take a copy before removing an organization whose records must stay available; backups taken afterwards do not hold it. A backup never restored is an assumption. Restore one now and then, and point the check below at the restored copy, connecting as a role like the server's — it refuses one that bypasses row-level security:

```sh
DATABASE_URL=… STORAGE_DIRECTORY=… bun run verify:files
```

It checks only the files the restored rows name. On a database with none it says nothing was checked rather than that everything matched, but a restore missing some records passes all the same, so confirm that the records you expect are there, too.

Discarding evidence takes its `file` rows by cascade and leaves the bytes on the volume. The upload handler removes bytes when an upload fails or its metadata cannot be committed, but there is no garbage collector for previously attached files. Storage therefore grows with successful uploads even when their evidence is later discarded. `bun run verify:files` walks rows and cannot see bytes no row claims ([ADR 0013](adr/0013-durable-storage.md)).

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
REVOKE DELETE         ON "organization"         FROM qualityruntime;  -- see below
```

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

It reads every referenced file in full, so schedule it according to storage size and workload. Investigate findings before restoring: a checksum mismatch indicates changed bytes, while missing or unreadable files can also indicate an incorrect `STORAGE_DIRECTORY`, an unmounted volume, or access problems ([ADR 0016](adr/0016-verifying-stored-bytes.md)).

Nothing records findings anywhere durable yet. Keep the output.

## The API reference

`/api/v1/reference` renders the OpenAPI document for a person to read. The browser loads its JavaScript from a CDN ([ADR 0015](adr/0015-a-rendered-api-reference.md)). If users' browsers cannot reach the CDN, set `API_REFERENCE_BUNDLE_URL` to a browser-accessible URL hosting your own copy of `@scalar/api-reference`. The server does not fetch this bundle; `/api/v1/openapi.json` is unaffected.

## Applying migrations

```sh
MIGRATION_DATABASE_URL=… bun run db:migrate
```

Run it as a step of its own before starting the server, not from the server: several instances starting at once would each try, and the role that applies migrations is deliberately not the one the server has.
