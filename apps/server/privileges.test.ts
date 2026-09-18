// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deployment posture, run as a deployment runs it.
 *
 * Applies the migrations as PGlite's default role, standing in for a migrator
 * that owns the tables, and creates a runtime role that owns none, then
 * exercises ordinary work and forbidden operations through that role.
 * Owner-based policy tests cannot establish these privilege restrictions: an
 * owner can disable row security or truncate its tables. The separate
 * `documented-setup.test.ts` verifies the setup SQL printed in the docs.
 *
 * Two things are being proved. That the product actually runs on the privileges
 * it documents, which is the part that is easy to get wrong and never notice.
 * And that with those privileges "append-only" and "final" hold against the
 * runtime role itself rather than only against the code (ADR 0014).
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/** The runtime role, named as `docs/deployment.md` names it. */
const runtime = "qualityruntime";

let client: PGlite;
let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;

const createTestDatabase = (pg: PGlite) => drizzle({ client: pg, schema, casing: "snake_case" });

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let control: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Evidence against a control, written as the runtime role inside the tenant.
 * No route records evidence yet; the table, its policies and the privileges
 * are what is being tested.
 */
const recordEvidence = (controlId: string, { attested = false } = {}) =>
  withOrganization(db, acme.organizationId, async (tx) => {
    const [row] = await tx
      .insert(schema.evidence)
      .values({
        organizationId: acme.organizationId,
        controlId,
        title: "Minutes",
        occurredAt: new Date("2026-07-01T09:00:00.000Z"),
      })
      .returning();
    if (attested) {
      const [signed] = await tx
        .update(schema.evidence)
        .set({
          attestedAt: new Date(),
          attestedById: "usr_0000000000000000",
          attestedByLabel: "Ada",
        })
        .where(eq(schema.evidence.id, row!.id))
        .returning();
      // A fixture that silently failed to attest would let every test built
      // on it pass for the wrong reason.
      expect(signed?.attestedAt).toBeInstanceOf(Date);
    }
    return row!.id;
  });

/** Whether a statement was refused, and what PostgreSQL said. */
async function refused(statement: string): Promise<string> {
  try {
    await client.exec(statement);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected PostgreSQL to refuse: ${statement}`);
}

beforeAll(async () => {
  client = new PGlite();
  db = createTestDatabase(client);

  // The migrator owns what it creates. PGlite's default role stands in for it.
  await migrate(db, { migrationsFolder });

  // Exactly what `docs/deployment.md` says to grant, and nothing else. If the
  // product needs more than this, this test is where that surfaces.
  //
  // The grants are applied directly rather than through the migrator role that
  // document describes, so what is proved here is the posture, not the setup:
  // `ALTER DEFAULT PRIVILEGES` and the migrator's own grants are not exercised.
  await client.exec(`
    CREATE ROLE ${runtime} NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO ${runtime};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};
    REVOKE UPDATE, DELETE ON "audit_event" FROM ${runtime};
    REVOKE UPDATE, DELETE ON "file" FROM ${runtime};
    REVOKE UPDATE ON "control_requirement" FROM ${runtime};
    REVOKE DELETE ON "organization" FROM ${runtime};
    SET ROLE ${runtime};
  `);

  app = createApp({
    db,
    auth: createAuth(db, {
      baseURL: "http://localhost",
      secret: "test-secret-of-at-least-32-characters",
    }),
  });

  const signedUp = await app.request(
    "/api/auth/sign-up/email",
    asJson({ name: "Ada", email: "acme@example.test", password: "correct horse" }),
  );
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const created = await app.request("/api/auth/organization/create", {
    ...asJson({ name: "Acme", slug: "acme" }),
    headers: { "content-type": "application/json", cookie },
  });
  expect(created.status).toBe(200);
  acme = { cookie, organizationId: (await json<{ id: string }>(created)).id };

  const madeControl = await request(acme, "/controls", asJson({ name: "Access review" }));
  expect(madeControl.status).toBe(201);
  control = (await json<{ data: { id: string } }>(madeControl)).data.id;
}, 60_000);

describe("the product runs on the privileges it documents", () => {
  it("signs a user up and creates an organization", () => {
    // Better Auth's own writes, through the runtime role.
    expect(acme.organizationId).toMatch(/^org_[0-9a-z]{16}$/);
  });

  it("changes a control and reads its history", async () => {
    const activated = await request(acme, `/controls/${control}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    expect(activated.status).toBe(200);

    const history = await request(acme, `/history?resource=${control}`);
    const { data } = await json<{ data: { action: string }[] }>(history);

    expect(history.status).toBe(200);
    expect(data.map((event) => event.action).sort()).toEqual(["created", "updated"]);
  });

  it("needs no privilege on a sequence, because nothing here has one", async () => {
    // Identifiers are generated by the application (ADR 0002), so a deployment
    // granting only table privileges is not missing something.
    const { rows } = await client.query<{ count: number }>(
      `select count(*)::int as count from information_schema.sequences where sequence_schema = 'public'`,
    );

    expect(rows[0]?.count).toBe(0);
  });
});

describe("what the runtime role cannot do", () => {
  it("cannot turn row-level security off", async () => {
    // The whole guarantee rests on this. An owner could; this role is not one.
    expect(await refused(`ALTER TABLE "control" DISABLE ROW LEVEL SECURITY`)).toMatch(
      /owner|permission/i,
    );
  });

  it("cannot truncate a table", async () => {
    // TRUNCATE is outside row security entirely, so only a privilege stops it.
    expect(await refused(`TRUNCATE TABLE "audit_event"`)).toMatch(/permission|denied/i);
  });

  it("cannot drop or alter the schema", async () => {
    expect(await refused(`CREATE TABLE "smuggled" ("a" integer)`)).toMatch(/permission|denied/i);
    expect(await refused(`ALTER TABLE "evidence" DROP COLUMN "attested_at"`)).toMatch(
      /owner|permission/i,
    );
  });

  it("cannot rewrite audit history, and is told so rather than ignored", async () => {
    // The policies already make an update match nothing. Revoking the privilege
    // turns a silent no-op into a refusal, which is what a bug deserves.
    expect(await refused(`UPDATE "audit_event" SET "action" = 'rewritten'`)).toMatch(
      /permission|denied/i,
    );
    expect(await refused(`DELETE FROM "audit_event"`)).toMatch(/permission|denied/i);
  });

  it("cannot change attested evidence, though it may change a draft", async () => {
    // Here the privilege is granted and the policy is what refuses: evidence is
    // ordinary until it is attested.
    const retitle = (evidenceId: string) =>
      withOrganization(db, acme.organizationId, (tx) =>
        tx
          .update(schema.evidence)
          .set({ title: "Behind the API" })
          .where(eq(schema.evidence.id, evidenceId))
          .returning(),
      );

    expect(await retitle(await recordEvidence(control))).toHaveLength(1);
    expect(await retitle(await recordEvidence(control, { attested: true }))).toEqual([]);
  });

  it("offers no route that would delete an organization", async () => {
    // Better Auth ships one, and it would cascade through every tenant-owned
    // table — audit log and attestations included — as an owner's self-serve
    // action. Removing a tenant is an operator's job.
    const response = await app.request("/api/auth/organization/delete", {
      ...asJson({ organizationId: acme.organizationId }),
      headers: { "content-type": "application/json", cookie: acme.cookie },
    });

    expect(response.status).toBe(404);
    const remaining = await db.select({ id: schema.organization.id }).from(schema.organization);
    expect(remaining).toHaveLength(1);
  });

  it("cannot take the audit log or an attestation out through a cascade", async () => {
    // A foreign key's cascade is a referential action: it answers to neither
    // row-level security nor the cascaded table's privileges. So `organization`
    // — which has no policies and which everything references — was a way to
    // delete the whole audit log with one statement the revokes above do not
    // cover. The privilege on the parent is what closes it.
    expect(await refused(`DELETE FROM "organization"`)).toMatch(/permission|denied/i);

    // `control` keeps its DELETE privilege; the foreign key is what refuses,
    // so evidence cannot be disposed of by removing what it is evidence of.
    // Inside a tenant context, since outside one the row is not even visible
    // and the delete would match nothing for the wrong reason.
    const made = await request(acme, "/controls", asJson({ name: "Backup restore" }));
    const doomed = (await json<{ data: { id: string } }>(made)).data.id;
    await recordEvidence(doomed);

    // Drizzle wraps the driver's error, so PostgreSQL's reason is the cause.
    const error = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.control).where(eq(schema.control.id, doomed)),
    ).then(
      () => null,
      (thrown: Error) => thrown,
    );

    const reason = error?.cause instanceof Error ? error.cause.message : error?.message;
    expect(reason).toMatch(/foreign key|still referenced/i);
  });

  it("holds no privilege that would cascade into a table nothing may delete from", async () => {
    // Derived, so a later table added with `ON DELETE cascade` into either of
    // these fails here rather than quietly reopening the hole above.
    const { rows } = await client.query<{ parent: string; child: string }>(
      `select parent.relname as parent, child.relname as child
       from pg_constraint fk
       join pg_class parent on parent.oid = fk.confrelid
       join pg_class child on child.oid = fk.conrelid
       where fk.contype = 'f'
         and fk.confdeltype = 'c'
         and child.relname in ('audit_event', 'evidence')
         and has_table_privilege($1, parent.oid, 'DELETE')
       order by parent.relname, child.relname`,
      [runtime],
    );

    expect(rows).toEqual([]);
  });

  it("holds no privilege a policy would never let it use", async () => {
    // Derived, so the grants `docs/deployment.md` lists cannot drift from the
    // schema: a table with no policy for a command is one the runtime role
    // should not hold that privilege on, and a future append-only table fails
    // here until its revoke is written down.
    //
    // Bounded by what it asks. Only tables with row security are considered, so
    // one where `ENABLE ROW LEVEL SECURITY` was forgotten is invisible here —
    // `assertTenantIsolation` and the cascade check above cover other ground.
    const { rows } = await client.query<{ relname: string; command: string }>(
      `select c.relname, p.privilege_type as command
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(privilege_type)
       where n.nspname = 'public' and c.relrowsecurity
         and has_table_privilege($1, c.oid, p.privilege_type)
         and not exists (
           select 1 from pg_policy pol
           where pol.polrelid = c.oid
             and pol.polcmd in ('*', case p.privilege_type
               when 'SELECT' then 'r' when 'INSERT' then 'a'
               when 'UPDATE' then 'w' else 'd' end)
         )
       order by c.relname, p.privilege_type`,
      [runtime],
    );

    expect(rows).toEqual([]);
  });

  it("sees nothing of another organization, as it never could", async () => {
    const theirs = await withOrganization(db, "org_0000000000000000", (tx) =>
      tx.select().from(schema.control),
    );

    expect(theirs).toEqual([]);
  });
});
