// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant context: the one way domain code reaches tenant-owned tables.
 *
 * Reasoning: `docs/adr/0003-tenant-isolation-with-row-level-security.md`.
 */

import { type ExtractTablesWithRelations, getTableName, is, sql, Table } from "drizzle-orm";
import { type PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { Database } from "./client.ts";
import * as auth from "./schema/auth.ts";
import * as schema from "./schema/index.ts";

type Schema = typeof schema;
type Relations = ExtractTablesWithRelations<Schema>;

/**
 * A `Database` that is not already a transaction — what a tenant context has to
 * start from.
 *
 * `rollback?: never` excludes a `PgTransaction`, which structurally satisfies
 * `Database` and declares `rollback`. The runtime check in `withOrganization`
 * is the real guard; this reports the mistake at the call site instead.
 */
export type RootDatabase<Q extends PgQueryResultHKT = PgQueryResultHKT> = Database<Q> & {
  rollback?: never;
};

/** The scoped handle `withOrganization` hands its callback. */
export type TenantTransaction<Q extends PgQueryResultHKT = PgQueryResultHKT> = PgTransaction<
  Q,
  Schema,
  Relations
>;

/**
 * The session setting the row-level security policies read. Namespaced so it
 * cannot collide with a PostgreSQL parameter or another extension's.
 */
const organizationSetting = "qualityruntime.organization_id";

/**
 * Every table this package defines except Better Auth's, which resolve a
 * user's memberships before any organization is known. Derived, so a new
 * domain table is checked without anyone remembering to list it;
 * `schema/migrations.test.ts` holds each of them to carrying `organization_id`.
 */
const authTables = new Set<string>(
  Object.values(auth).flatMap((value) => (is(value, Table) ? [getTableName(value)] : [])),
);
const domainTables = Object.values(schema).flatMap((value) =>
  is(value, Table) && !authTables.has(getTableName(value)) ? [getTableName(value)] : [],
);

/**
 * Fails unless row-level security is in force on this connection.
 *
 * Domain code relies on the policies rather than repeating a tenant predicate
 * in every query. At startup, this checks the connection role and the tables
 * for configuration that disables row security or prevents ordinary requests:
 *
 * - The role is a superuser or `BYPASSRLS` — the `postgres` superuser a
 *   container image creates by default, say — and every policy is inert. No
 *   migration can prevent that.
 * - A domain table is missing, or its row security is not both enabled and
 *   forced: the database was not migrated, or someone altered it. A table with
 *   row security disabled ignores its policies entirely.
 * - `row_security` is off, which is the migrator's setting (ADR 0014). That
 *   fails closed rather than leaking, but every request would then fail; one
 *   clear refusal now is better.
 *
 * This checks row-security flags, not policy presence or definitions, table
 * ownership, or grants. Migrations and tests establish the policies; deployment
 * role setup supplies the privilege restrictions.
 */
export async function assertTenantIsolation<Q extends PgQueryResultHKT>(
  db: RootDatabase<Q>,
): Promise<void> {
  // Every PostgreSQL driver returns `{ rows }`, but the handle is generic over
  // the driver's result type, so TypeScript cannot see that from here.
  type Role = { role: string; exempt: boolean; rowSecurity: string };
  const { rows: roles } = (await db.execute<Role>(
    sql`select current_user as role, (rolsuper or rolbypassrls) as exempt,
               current_setting('row_security') as "rowSecurity"
        from pg_catalog.pg_roles where rolname = current_user`,
  )) as unknown as { rows: Role[] };
  const [role] = roles;

  if (!role) {
    throw new Error("Could not determine whether the database role bypasses row-level security.");
  }
  if (role.exempt) {
    throw new Error(
      `The database role "${role.role}" bypasses row-level security, which disables tenant ` +
        "isolation. Connect as a role that is neither a superuser nor BYPASSRLS; see docs/deployment.md.",
    );
  }
  if (role.rowSecurity === "off") {
    throw new Error(
      `The database role "${role.role}" runs with row_security = off, which is the migrator's ` +
        "setting. Connect as the server's own role; see docs/deployment.md.",
    );
  }

  type Enforced = { table: string };
  const { rows: enforced } = (await db.execute<Enforced>(
    sql`select c.relname as "table"
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relrowsecurity and c.relforcerowsecurity
          and c.relname in (${sql.join(
            domainTables.map((name) => sql`${name}`),
            sql`, `,
          )})`,
  )) as unknown as { rows: Enforced[] };
  const found = new Set(enforced.map((row) => row.table));
  const unenforced = domainTables.filter((name) => !found.has(name)).sort();

  if (unenforced.length > 0) {
    throw new Error(
      `Row-level security is not enabled and forced on ${unenforced.join(", ")}, so tenant ` +
        "isolation does not hold there. Apply the migrations, and do not alter row security by hand.",
    );
  }
}

/**
 * Runs `work` in a transaction scoped to one organization.
 *
 * Row-level security decides what the transaction can see and write, so a query
 * that forgets its `where organization_id = …` returns that tenant's rows
 * rather than everyone's, and a write cannot label a row with another tenant's
 * id. Domain code should take the transaction rather than a raw handle.
 *
 * This is **not** authorization: it scopes a request that has already been
 * authorized. Whether the caller may act in this organization is decided from
 * their `member` row, before this is called (TENANT-01).
 *
 * `set_config(…, true)` is `SET LOCAL` as a function, so the value is bound
 * rather than interpolated into SQL, and PostgreSQL discards it when the
 * transaction ends — including on rollback, and before the connection returns
 * to the pool.
 *
 * Throws when handed a transaction. Drizzle would open a savepoint, and a
 * savepoint does not scope `SET LOCAL`: releasing it leaves the new
 * organization in force, so the rest of the outer transaction would silently
 * run as the wrong tenant. Code inside a tenant context already has the
 * transaction it needs and must not re-scope it.
 */
export async function withOrganization<Q extends PgQueryResultHKT, T>(
  db: RootDatabase<Q>,
  organizationId: string,
  work: (tx: TenantTransaction<Q>) => Promise<T>,
  {
    repeatableRead = false,
  }: {
    /**
     * Read everything from one snapshot rather than a fresh one per statement.
     *
     * Under `read committed` — the default — two statements in the same
     * transaction can see two different committed states. That is right for a
     * write deciding from what is stored now, and wrong for a read whose
     * answers have to agree with each other: a page of a collection and a
     * version describing that collection, for one.
     *
     * Set at `BEGIN`, so it cannot be turned on once a statement has run.
     */
    repeatableRead?: boolean;
  } = {},
): Promise<T> {
  if (is(db, PgTransaction)) {
    throw new Error("withOrganization cannot nest: a savepoint does not scope the organization.");
  }

  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config(${organizationSetting}, ${organizationId}, true)`);
      return work(tx);
    },
    // Pass undefined, not {}: the PGlite adapter treats any config as a
    // SET TRANSACTION request, and an empty one produces invalid SQL.
    repeatableRead ? { isolationLevel: "repeatable read" } : undefined,
  );
}
