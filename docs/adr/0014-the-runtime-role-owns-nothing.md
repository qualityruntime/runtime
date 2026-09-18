# 14. The runtime role owns nothing

Date: 2026-09-18

## Status

Accepted

## Context

Three decisions here rest on PostgreSQL refusing something: tenant isolation ([ADR 0003](0003-tenant-isolation-with-row-level-security.md)), an append-only audit log ([ADR 0005](0005-audit-history.md)), and evidence that cannot change once attested ([ADR 0012](0012-evidence-and-attestation.md)).

All three were qualified in the same way, and the qualification has been carried forward for eleven iterations: _against the application_. `FORCE ROW LEVEL SECURITY` makes the policies apply to a table's owner, which is what makes the single-role setup safe against a forgotten predicate. It does nothing about the rest of what an owner may do. `TRUNCATE` is outside row security entirely. So is `ALTER TABLE … DISABLE ROW LEVEL SECURITY`. So is dropping a column.

`docs/deployment.md` described the separation that fixes this under a heading called _Hardening_, as something a deployment _could_ do. Nothing did it, nothing tested it, and no one had checked that the product would actually run that way.

## Decision

**Two roles, and the separation is the supported setup rather than a recommendation.**

A migrator owns the schema and applies migrations. The server connects as a role that owns nothing and holds `SELECT, INSERT, UPDATE, DELETE` and no more. `MIGRATION_DATABASE_URL` is the migrator's and `DATABASE_URL` is the server's. `drizzle-kit` reads only the first: falling back to the server's would run a migration without the migrator's guard below.

The migrator is not given `BYPASSRLS`. It owns the tables, `FORCE ROW LEVEL SECURITY` holds it to the policies, and a data migration that forgot to choose a tenant would then succeed on zero rows. The role runs with `row_security = off` instead, which rejects queries subject to row security, even with a matching tenant context. This makes accidental tenant-data access fail loudly. Intentional tenant-scoped data migrations must enable row security locally and establish their tenant context, as described in [deployment](../deployment.md#two-roles). Nothing is exempted.

Grants come from `ALTER DEFAULT PRIVILEGES FOR ROLE <migrator>`, set once, so every table a future migration creates is usable without a grant per migration.

**Some privileges are then taken back:**

```sql
REVOKE UPDATE, DELETE ON "audit_event"          FROM qualityruntime;
REVOKE UPDATE, DELETE ON "file"                 FROM qualityruntime;
REVOKE UPDATE         ON "control_requirement"  FROM qualityruntime;
REVOKE DELETE         ON "organization"         FROM qualityruntime;
```

None of the first three is decoration, and none is strictly necessary — the policies already make such a statement match nothing. What they change is the failure: a silent no-op becomes a refusal, which is what a bug in this area deserves.

**The last is necessary, and it is the one the others do not cover.** A foreign key's `ON DELETE cascade` is a referential action, subject to neither row-level security nor the privileges on the table it cascades into. Every tenant-owned table references `organization`, and `organization` is Better Auth's table with no policies of its own, so `DELETE FROM "organization"` deletes the audit log and every attestation in one statement that the revokes above do not touch. Taking the privilege on the parent is what closes it. Better Auth's own `organization/delete` route is disabled for the same reason: removing a tenant is an operator's deliberate act, not a customer administrator's API call.

The other cascade into a final record was `evidence`'s own parent. Deleting a control took its attested evidence with it, around [ADR 0012](0012-evidence-and-attestation.md)'s policy; that foreign key is now `ON DELETE restrict`, so evidence has to be disposed of deliberately and attested evidence cannot be.

**The list is derived rather than maintained.** `apps/server/privileges.test.ts` asks PostgreSQL which tables have row security and no policy for a command, and asserts the runtime role holds no such privilege. A second derivation asks which tables cascade into `audit_event` or `evidence` and asserts the role cannot delete from any of them, so a later table wired up with `ON DELETE cascade` fails the suite rather than quietly reopening the hole above. A future append-only table fails the suite until its revoke is written into `docs/deployment.md`.

Both derivations are bounded by what they ask about. The first sees only tables with row security enabled, so an append-only table that is not tenant-scoped — or one where `ENABLE ROW LEVEL SECURITY` was forgotten — is invisible to it, and neither looks at which roles a policy names. That the `file` revoke is on this list at all is that test's doing: it was not in the first draft, and the derivation found it.

**The setup is run, and so is the posture.** `apps/server/documented-setup.test.ts` takes the SQL out of both documents, runs it in the order they give, applies the migrations as the migrator, drives the product as the runtime role, and then asks PostgreSQL what that role ended up holding — so a document that stops working, or that quietly grants more, fails the suite. That it was written at all is a finding's doing: `docs/deployment.md` carried a setup block that could not apply a migration, because drizzle-kit creates a schema for its journal and the grant for that was in the other document.

**The posture is run, not just described.** The same test sets the two roles up, then signs a user up, creates a control, records evidence, uploads a file and imports a standard — all through the runtime role. It stops short of attesting and of mapping a control, so those are covered by the ordinary suites rather than by this one. Then it asserts what that role cannot do: disable row security, truncate, alter the schema, rewrite audit history, or change attested evidence. A deployment document nobody has executed is a guess, and this is the difference between the product running on these privileges and being believed to.

## Consequences

The three guarantees above stop being qualified. Audit history is append-only against the role, not merely against the code; attested evidence is final against the role; and a compromised request path cannot turn isolation off, because the credential it would use cannot.

They hold only with the cascade revoke in place. Privileges and policies describe what a role may do; a referential action is something the database does on its own behalf, and it obeys neither. Any future foreign key into a table whose rows are meant to be permanent has to be `restrict`, or the parent has to be out of the role's reach.

Setting up a database is now two roles instead of one, locally as well as in a deployment, because development that does not match production is how a deployment-only failure gets discovered in a deployment. The grants are a handful of statements and they are written out in both documents.

Applying migrations is a step of its own, with its own credential. It should not run from the server: several instances starting at once would each try, and the role the server has is deliberately not the one that can.

Nothing enforces the separation. A deployment can still point both URLs at one owning role, and everything will work — with the older, weaker guarantee — unless that role carries the migrator's `row_security = off`, which the server refuses because every request would then fail. `assertTenantIsolation` refuses a superuser because that breaks isolation outright and silently; ownership does not, so refusing to start would be wrong. What ownership costs is written down instead.

`GRANT … ON ALL TABLES` is a snapshot. It is the default privileges that keep future tables covered, and the order matters: set the default privileges _before_ the first migration, or the tables that migration creates get nothing. On a database whose tables already exist the snapshot grant is needed as well, which `docs/deployment.md` gives as a one-off outside the setup block — on a fresh database it grants nothing, and a statement that quietly does nothing is one nobody can tell is wrong.

The setup blocks need a superuser. `ALTER DEFAULT PRIVILEGES FOR ROLE` requires superuser or membership in the role it names, and so does revoking on a table the revoker does not own — a `CREATEROLE` administrator is refused, and is refused in a way that leaves the privilege in place.
