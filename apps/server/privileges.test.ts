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

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { fileStoreOnDisk } from "./storage-on-disk.ts";

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
    store: fileStoreOnDisk(await mkdtemp(join(tmpdir(), "qualityruntime-"))),
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

  it("records a control, its evidence, and a file", async () => {
    const evidence = await request(
      acme,
      `/controls/${control}/evidence`,
      asJson({ title: "Q3 review", occurredAt: "2026-07-01T09:00:00.000Z" }),
    );
    expect(evidence.status).toBe(201);
    const evidenceId = (await json<{ data: { id: string } }>(evidence)).data.id;

    const uploaded = await request(acme, `/evidence/${evidenceId}/files?filename=notes.txt`, {
      method: "POST",
      body: "the minutes",
    });

    expect(uploaded.status).toBe(201);
  });

  it("imports a standard and maps a control to it", async () => {
    const imported = await request(
      acme,
      "/standards",
      asJson({
        name: "ISO 9001",
        edition: "2015",
        requirements: [{ reference: "7.5.3", title: "Documented information" }],
      }),
    );
    expect(imported.status).toBe(201);
    const standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const { data } = await json<{ data: { id: string }[] }>(
      await request(acme, `/standards/${standardId}/requirements`),
    );

    const mapped = await request(acme, `/controls/${control}/requirements`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirementIds: [data[0]!.id] }),
    });

    expect(mapped.status).toBe(200);
  });

  it("attests evidence and then refuses to change it", async () => {
    const evidence = await request(
      acme,
      `/controls/${control}/evidence`,
      asJson({ title: "Attested here", occurredAt: "2026-07-01T09:00:00.000Z" }),
    );
    const evidenceId = (await json<{ data: { id: string } }>(evidence)).data.id;
    const tag = (await request(acme, `/evidence/${evidenceId}`)).headers.get("etag")!;

    const attested = await request(acme, `/evidence/${evidenceId}/attestation`, {
      method: "PUT",
      headers: { "if-match": tag },
    });
    const amended = await request(acme, `/evidence/${evidenceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Rewritten" }),
    });

    expect(attested.status).toBe(200);
    expect(amended.status).toBe(409);
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
    // ordinary until it is attested (ADR 0012).
    const record = async () => {
      const evidence = await request(
        acme,
        `/controls/${control}/evidence`,
        asJson({ title: "Final", occurredAt: "2026-07-01T09:00:00.000Z" }),
      );
      return (await json<{ data: { id: string } }>(evidence)).data.id;
    };
    const retitle = (evidenceId: string) =>
      withOrganization(db, acme.organizationId, (tx) =>
        tx
          .update(schema.evidence)
          .set({ title: "Behind the API" })
          .where(eq(schema.evidence.id, evidenceId))
          .returning(),
      );

    expect(await retitle(await record())).toHaveLength(1);

    const signed = await record();
    const tag = (await request(acme, `/evidence/${signed}`)).headers.get("etag")!;
    const attested = await request(acme, `/evidence/${signed}/attestation`, {
      method: "PUT",
      headers: { "if-match": tag },
    });
    // Without this, a failed attestation would let the refusal below pass for
    // the wrong reason.
    expect(attested.status).toBe(200);

    expect(await retitle(signed)).toEqual([]);
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
    const recorded = await request(
      acme,
      `/controls/${doomed}/evidence`,
      asJson({ title: "Restored", occurredAt: "2026-07-01T09:00:00.000Z" }),
    );
    expect(recorded.status).toBe(201);

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
