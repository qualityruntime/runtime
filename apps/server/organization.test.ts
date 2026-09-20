// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The organization request context, and the one route that uses it, driven
 * through real HTTP requests against a migrated database.
 *
 * Two organizations with real memberships, created through Better Auth rather
 * than seeded, so what is exercised is the path an actual client takes.
 *
 * Requests run as a non-superuser role that owns the tables, with row-level
 * security forced so the policies bind their owner — PGlite's default role is a
 * superuser and PostgreSQL exempts those from every policy, so the tenant
 * scoping below would be vacuous otherwise. The deployment's own posture, a
 * runtime role that owns nothing, is `privileges.test.ts`'s subject. The routes carry no `where organization_id`: that the rows come
 * back scoped anyway is the whole point.
 */

import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { inMemoryObjectStore } from "./s3-in-memory.ts";
import { type Auth, createAuth } from "./auth.ts";
import { organizationContext, type OrganizationEnv } from "./organization.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let auth: Auth;
let app: ReturnType<typeof createApp>;

/** A signed-in user who owns one organization holding one control. */
type Tenant = { cookie: string; organizationId: string; controlName: string };

let acme: Tenant;
let globex: Tenant;
/** Signed in, but a member of nothing. */
let outsider: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

async function signUp(email: string): Promise<string> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email, password: "correct horse battery" }),
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function createTenant(slug: string, controlName: string): Promise<Tenant> {
  const cookie = await signUp(`${slug}@example.test`);
  const created = await app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: slug, slug }),
  });
  expect(created.status).toBe(200);
  const { id } = await json<{ id: string }>(created);

  await db.insert(schema.control).values({ organizationId: id, name: controlName });
  return { cookie, organizationId: id, controlName };
}

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  auth = createAuth(db, {
    baseURL: "http://localhost",
    secret: "test-secret-of-at-least-32-characters",
  });
  app = createApp({
    db,
    store: inMemoryObjectStore().store,
    auth,
  });

  acme = await createTenant("acme", "Access review");
  globex = await createTenant("globex", "Supplier audit");
  outsider = await signUp("outsider@example.test");

  // Fixtures are seeded above as the superuser; everything from here runs as
  // the application role, so the policies apply (ADR 0003).
  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

const listControls = (organizationId: string, cookie?: string) =>
  app.request(`/api/v1/organizations/${organizationId}/controls`, {
    headers: cookie ? { cookie } : {},
  });

describe("authentication", () => {
  it("refuses an anonymous request", async () => {
    const response = await listControls(acme.organizationId);

    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });
  });

  it("refuses a request carrying a nonsense session cookie", async () => {
    const response = await listControls(acme.organizationId, "better-auth.session_token=forged");

    expect(response.status).toBe(401);
  });
});

describe("response headers", () => {
  it("forbids caching every response, refused or served", async () => {
    // Cookie-authenticated and membership-dependent: a shared cache reusing one
    // of these would hand a member's controls to an outsider, or the reverse.
    const served = await listControls(acme.organizationId, acme.cookie);
    const refused = await listControls(acme.organizationId, outsider);
    const anonymous = await listControls(acme.organizationId);

    for (const response of [served, refused, anonymous]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("forbids caching a response a handler built itself", async () => {
    // A raw `Response` never passes through Hono's prepared headers, so the
    // middleware has to put this one back on afterwards.
    const raw = new Hono<OrganizationEnv>()
      .use("/organizations/:organizationId/*", organizationContext({ auth, db }))
      .get("/organizations/:organizationId/raw", () => new Response("ok"));

    const response = await raw.request(`/organizations/${acme.organizationId}/raw`, {
      headers: { cookie: acme.cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes on the cookie Better Auth issues for an ageing session", async () => {
    // Better Auth renews a session that is close to expiring and returns the
    // replacement cookie in its own headers. Dropping it would keep extending
    // the session in the database while the browser signed out on schedule.
    const email = "renewed@example.test";
    const cookie = await signUp(email);
    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    // Close enough to expiry that Better Auth renews it on the next look-up.
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(schema.session.userId, user!.id));

    const response = await listControls(acme.organizationId, cookie);

    expect(response.headers.getSetCookie().join()).toMatch(/session_token/);
  });
});

describe("failure shape", () => {
  it("answers an unknown endpoint in the documented envelope", async () => {
    const response = await app.request("/api/v1/nope");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("answers an unsupported method on a real resource the same way", async () => {
    // DELETE is not part of the control resource; the collection itself is.
    const response = await app.request(`/api/v1/organizations/${acme.organizationId}/controls`, {
      method: "DELETE",
      headers: { cookie: acme.cookie },
    });

    expect(response.status).toBe(404);
    expect(await json<{ error: { code: string } }>(response)).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("membership", () => {
  it("serves a member of the organization", async () => {
    const response = await listControls(acme.organizationId, acme.cookie);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: { name: string }[] }>(response);
    expect(data.map((row) => row.name)).toEqual([acme.controlName]);
  });

  it("refuses a signed-in user who is a member of another organization", async () => {
    const response = await listControls(acme.organizationId, globex.cookie);

    expect(response.status).toBe(404);
  });

  it("refuses a signed-in user who is a member of nothing", async () => {
    const response = await listControls(acme.organizationId, outsider);

    expect(response.status).toBe(404);
  });

  it.each([
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "usr_v1stgxr8z5jdhi6b"],
    ["a percent-encoded NUL", "%00"],
  ])("refuses %s as an organization", async (_case, id) => {
    // The last would otherwise be handed to PostgreSQL, which rejects NUL in
    // `text` and would turn a plain absence into a 500.
    const response = await listControls(id, acme.cookie);

    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found");
  });

  it("answers the same way for an organization that does not exist", async () => {
    // A non-member must not be able to tell the two apart: were this a 403,
    // any leaked identifier would become a membership oracle.
    const missing = await listControls("org_0000000000000000", acme.cookie);
    const forbidden = await listControls(globex.organizationId, acme.cookie);

    expect(missing.status).toBe(forbidden.status);
    expect(await json(missing)).toEqual(await json(forbidden));
  });
});

describe("tenant scoping", () => {
  it("shows each organization only its own controls", async () => {
    const mine = await json<{ data: { name: string }[] }>(
      await listControls(globex.organizationId, globex.cookie),
    );

    expect(mine.data.map((row) => row.name)).toEqual([globex.controlName]);
  });

  it("does not let the session's active organization override the path", async () => {
    // Better Auth sets `session.activeOrganizationId` when an organization is
    // created, so Acme's session is *active* in Acme. Asking for Globex must
    // still be refused on membership, not quietly answered with Acme's rows.
    const response = await listControls(globex.organizationId, acme.cookie);

    expect(response.status).toBe(404);
  });
});
