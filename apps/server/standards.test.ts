// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Importing a standard, and reading it back in the order it states.
 *
 * Requirements are the first collection ordered by something other than time,
 * so most of what is checked here is that a second ordering behaves like the
 * first without borrowing its cursors. Requests run as a non-superuser role
 * that owns the tables, so the row-level security policies are in force as they
 * are in a deployment.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { fileStoreOnDisk } from "./storage-on-disk.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/** A store of its own, thrown away with the run. */
const temporaryStore = async () =>
  fileStoreOnDisk(await mkdtemp(join(tmpdir(), "qualityruntime-")));

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;
type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Standard = { id: string; name: string; edition: string; requirementCount: number };
type Requirement = {
  id: string;
  reference: string;
  title: string;
  text: string | null;
  position: number;
};
type Page<T> = { data: T[]; nextCursor: string | null };
type Failure = { error: { code: string; details?: { path: string }[] } };

const request = (
  tenant: Tenant,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    // Merged, not replaced: a caller's own headers are the point of
    // passing them, and dropping them silently makes a test pass for
    // the wrong reason.
    headers: {
      cookie: tenant.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

/** A standard of `count` clauses, numbered so that lexical order is wrong. */
const clauses = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    reference: `7.${index + 1}`,
    title: `Clause ${index + 1}`,
    text: index === 0 ? null : `The organization shall do thing ${index + 1}.`,
  }));

async function importStandard(tenant: Tenant, body: unknown): Promise<Standard> {
  const response = await request(tenant, "/standards", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: Standard }>(response)).data;
}

/** Walks every page, returning what a client would have collected. */
async function walk<T>(tenant: Tenant, path: string, query: string): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 30; guard++) {
    const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const response = await request(tenant, `${path}?${query}${suffix}`);
    expect(response.status).toBe(200);
    const body: Page<T> = await json<Page<T>>(response);
    collected.push(...body.data);
    if (!body.nextCursor) return collected;
    cursor = body.nextCursor;
  }
  throw new Error("paging did not terminate");
}

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  app = createApp({
    db,
    store: await temporaryStore(),
    auth: createAuth(db, {
      baseURL: "http://localhost",
      secret: "test-secret-of-at-least-32-characters",
    }),
  });

  const tenant = async (slug: string): Promise<Tenant> => {
    const signedUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        email: `${slug}@example.test`,
        password: "correct horse",
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: slug, slug }),
    });
    expect(created.status).toBe(200);
    return { cookie, organizationId: (await json<{ id: string }>(created)).id };
  };

  acme = await tenant("acme");
  globex = await tenant("globex");

  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    alter table "standard" owner to qualityruntime_app;
    alter table "requirement" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

describe("importing a standard", () => {
  it("stores the standard and everything it states, in one request", async () => {
    const imported = await importStandard(acme, {
      name: "ISO 9001",
      edition: "2015",
      requirements: clauses(3),
    });

    expect(imported.id).toMatch(/^std_[0-9a-z]{16}$/);
    expect(imported.requirementCount).toBe(3);
    const { data } = await json<Page<Requirement>>(
      await request(acme, `/standards/${imported.id}/requirements`),
    );
    expect(data.map((row) => row.reference)).toEqual(["7.1", "7.2", "7.3"]);
    expect(data.map((row) => row.position)).toEqual([1, 2, 3]);
    expect(data[0]?.text).toBeNull();
  });

  it("refuses a second import of the same edition", async () => {
    const body = { name: "SOC 2", edition: "2017", requirements: clauses(2) };
    await importStandard(acme, body);

    const again = await request(acme, "/standards", { method: "POST", body: JSON.stringify(body) });

    expect(again.status).toBe(409);
    expect((await json<Failure>(again)).error.code).toBe("already_exists");
  });

  it("accepts a different edition of the same standard", async () => {
    await importStandard(acme, { name: "ISO 27001", edition: "2013", requirements: clauses(1) });

    const later = await importStandard(acme, {
      name: "ISO 27001",
      edition: "2022",
      requirements: clauses(2),
    });

    expect(later.edition).toBe("2022");
  });

  it("lets another organization import the same standard", async () => {
    const theirs = await importStandard(globex, {
      name: "ISO 9001",
      edition: "2015",
      requirements: clauses(1),
    });

    expect(theirs.name).toBe("ISO 9001");
  });

  it("refuses a clause repeated after trimming", async () => {
    // The database says the same thing, and reaching it would be a 500 for
    // what is plainly malformed input.
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Repeated",
        edition: "1",
        requirements: [
          { reference: "1", title: "First" },
          { reference: " 1 ", title: "Also first" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("writes nothing at all when the body is refused", async () => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Half a standard",
        edition: "1",
        requirements: [
          { reference: "1", title: "Fine" },
          { reference: "2", title: "  " },
        ],
      }),
    });

    expect(response.status).toBe(400);
    const all = await walk<Standard>(acme, "/standards", "limit=100");
    expect(all.map((row) => row.name)).not.toContain("Half a standard");
  });

  it("writes nothing new when the standard is already here", async () => {
    // The import returns before touching requirements or history, so a refused
    // second import leaves the first exactly as it was.
    const body = { name: "Once only", edition: "1", requirements: clauses(3) };
    const first = await importStandard(acme, body);

    const again = await request(acme, "/standards", { method: "POST", body: JSON.stringify(body) });
    expect(again.status).toBe(409);

    const events = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .select()
        .from(schema.auditEvent)
        .where(
          and(
            eq(schema.auditEvent.resourceType, "standard"),
            eq(schema.auditEvent.resourceId, first.id),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    const { data } = await json<Page<Requirement>>(
      await request(acme, `/standards/${first.id}/requirements?limit=100`),
    );
    expect(data).toHaveLength(3);
  });

  it("counts the requirements it stored, on the list and on the standard", async () => {
    const imported = await importStandard(acme, {
      name: "Counted",
      edition: "1",
      requirements: clauses(4),
    });

    const retrieved = await json<{ data: Standard }>(
      await request(acme, `/standards/${imported.id}`),
    );
    const listed = (await walk<Standard>(acme, "/standards", "limit=100")).find(
      (row) => row.id === imported.id,
    );

    expect(retrieved.data.requirementCount).toBe(4);
    expect(listed?.requirementCount).toBe(4);
  });

  it("accepts an import larger than another route would take", async () => {
    // Well past the 64 KiB a control is allowed, and well inside the ceiling.
    const long = "x".repeat(40_000);
    const imported = await importStandard(acme, {
      name: "Wordy",
      edition: "1",
      requirements: [
        { reference: "1", title: "First", text: long },
        { reference: "2", title: "Second", text: long },
      ],
    });

    expect(imported.requirementCount).toBe(2);
  });

  it("refuses an import past its 1 MiB body limit", async () => {
    // Every clause valid on its own, so only the body limit can refuse it.
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Oversized",
        edition: "1",
        requirements: Array.from({ length: 22 }, (_, index) => ({
          reference: `${index + 1}`,
          title: "Long",
          text: "x".repeat(50_000),
        })),
      }),
    });

    expect(response.status).toBe(413);
  });

  it("refuses a field it does not know on the standard itself", async () => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Misspelt",
        edtion: "1",
        edition: "1",
        requirements: [{ reference: "1", title: "A" }],
      }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses a field it does not know, rather than dropping what it holds", async () => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Misspelt",
        edition: "1",
        requirements: [{ reference: "1", title: "A", tetx: "The wording, lost" }],
      }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses more requirements than one import may carry", async () => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({ name: "Too many", edition: "1", requirements: clauses(2_001) }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain(
      "requirements",
    );
  });

  it.each([
    ["no requirements at all", { name: "Empty", edition: "1", requirements: [] }],
    ["no edition", { name: "Unversioned", requirements: [{ reference: "1", title: "A" }] }],
    ["a clause with no reference", { name: "N", edition: "1", requirements: [{ title: "A" }] }],
  ])("refuses %s", async (_case, body) => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("records the import as one event, not one per clause", async () => {
    const imported = await importStandard(acme, {
      name: "Audited",
      edition: "1",
      requirements: clauses(5),
    });

    const response = await request(acme, `/history?resource=${imported.id}`);
    expect(response.status).toBe(200);
    const { data } = await json<Page<{ action: string; resourceType: string }>>(response);

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: "created",
      resourceType: "standard",
      after: { name: "Audited", edition: "1", requirementCount: 5 },
    });
  });
});

describe("reading requirements in the order they are stated", () => {
  let standard: Standard;

  beforeAll(async () => {
    // Twelve, so that clause 10 exists: `7.10` sorts before `7.9` lexically,
    // and ordering by reference rather than position would show it.
    standard = await importStandard(acme, {
      name: "Ordered",
      edition: "1",
      requirements: clauses(12),
    });
  });

  it("pages through every clause once, in the standard's order", async () => {
    const walked = await walk<Requirement>(
      acme,
      `/standards/${standard.id}/requirements`,
      "limit=5",
    );

    expect(walked.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(walked.map((row) => row.reference)).toEqual(
      Array.from({ length: 12 }, (_, index) => `7.${index + 1}`),
    );
  });

  it("pages across clauses that share a position, by identifier", async () => {
    // Positions may tie, so the identifier is part of the order. An import
    // cannot make a tie, so this one is made in the database.
    const standard = await importStandard(acme, {
      name: "Tied positions",
      edition: "1",
      requirements: clauses(3),
    });
    await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.requirement)
        .set({ position: 2 })
        .where(eq(schema.requirement.standardId, standard.id)),
    );
    const tied = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .select({ id: schema.requirement.id })
        .from(schema.requirement)
        .where(eq(schema.requirement.standardId, standard.id)),
    );

    const walked = await walk<Requirement>(
      acme,
      `/standards/${standard.id}/requirements`,
      "limit=1",
    );

    expect(walked.map((row) => row.id)).toEqual(tied.map((row) => row.id).sort());
  });

  it("refuses a cursor from another standard's requirements", async () => {
    // Every standard numbers its clauses from one, so the key alone would be
    // accepted here and would resume from a position that means something else.
    const other = await importStandard(acme, {
      name: "Elsewhere",
      edition: "1",
      requirements: clauses(3),
    });
    const theirs = await json<Page<Requirement>>(
      await request(acme, `/standards/${other.id}/requirements?limit=1`),
    );
    expect(theirs.nextCursor).not.toBeNull();

    const response = await request(
      acme,
      `/standards/${standard.id}/requirements?cursor=${encodeURIComponent(theirs.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it("refuses a cursor from another control's history", async () => {
    // Same defect as between standards, one level down: every control's history
    // is newest first, so only the control in the cursor tells them apart.
    const made = async (name: string) => {
      const response = await request(acme, "/controls", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      expect(response.status).toBe(201);
      return (await json<{ data: { id: string } }>(response)).data.id;
    };
    const first = await made("Has history");
    const second = await made("Also has history");
    await request(acme, `/controls/${first}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed" }),
    });
    const theirs = await json<Page<{ id: string }>>(
      await request(acme, `/history?resource=${first}&limit=1`),
    );
    expect(theirs.nextCursor).not.toBeNull();

    const response = await request(
      acme,
      `/history?resource=${second}&cursor=${encodeURIComponent(theirs.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it("refuses a cursor from a collection ordered the other way", async () => {
    // A position in one ordering means nothing in another, and answering from
    // the wrong place would be worse than refusing.
    const standards = await json<Page<Standard>>(await request(acme, "/standards?limit=1"));
    expect(standards.nextCursor).not.toBeNull();

    const response = await request(
      acme,
      `/standards/${standard.id}/requirements?cursor=${encodeURIComponent(standards.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it.each([
    ["past what an integer holds", "2147483648"],
    ["not a number", "seven"],
    ["empty", ""],
  ])("refuses a cursor whose position is %s", async (_case, position) => {
    // A position the cast to integer would refuse must be a 400, not a 500.
    const standard = await importStandard(acme, {
      name: `Positions ${position || "empty"}`,
      edition: "1",
      requirements: clauses(1),
    });
    const [only] = await walk<Requirement>(acme, `/standards/${standard.id}/requirements`, "");
    const cursor = Buffer.from(
      `requirements/${standard.id}:stated|${position}|${only!.id}`,
      "utf8",
    ).toString("base64url");

    const response = await request(
      acme,
      `/standards/${standard.id}/requirements?cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it("refuses a cursor from a different collection ordered the same way", async () => {
    // Controls and standards are both newest first, so the key would be
    // accepted on either. Only the collection in the cursor tells them apart,
    // and answering a list of standards from a position in the controls is the
    // kind of wrong that looks like it worked.
    await request(acme, "/controls", { method: "POST", body: JSON.stringify({ name: "One" }) });
    await request(acme, "/controls", { method: "POST", body: JSON.stringify({ name: "Two" }) });
    const controls = await json<Page<{ id: string }>>(await request(acme, "/controls?limit=1"));
    expect(controls.nextCursor).not.toBeNull();

    const response = await request(
      acme,
      `/standards?cursor=${encodeURIComponent(controls.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });
});

describe("standards and tenants", () => {
  it("shows an organization only its own standards", async () => {
    const ours = await importStandard(acme, {
      name: "Ours",
      edition: "1",
      requirements: clauses(1),
    });
    const theirs = await importStandard(globex, {
      name: "Theirs",
      edition: "1",
      requirements: clauses(1),
    });

    const mine = (await walk<Standard>(acme, "/standards", "limit=100")).map((row) => row.id);
    const yours = (await walk<Standard>(globex, "/standards", "limit=100")).map((row) => row.id);

    expect(mine).toContain(ours.id);
    expect(mine).not.toContain(theirs.id);
    expect(yours).toContain(theirs.id);
    expect(yours).not.toContain(ours.id);
  });

  it("answers 404 for another organization's standard", async () => {
    const theirs = await importStandard(globex, {
      name: "Globex only",
      edition: "1",
      requirements: clauses(1),
    });

    const retrieved = await request(acme, `/standards/${theirs.id}`);
    const requirements = await request(acme, `/standards/${theirs.id}/requirements`);

    expect(retrieved.status).toBe(404);
    expect(requirements.status).toBe(404);
  });

  it.each([
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "ctl_v1stgxr8z5jdhi6b"],
  ])("answers 404 for %s", async (_case, id) => {
    expect((await request(acme, `/standards/${id}`)).status).toBe(404);
  });
});
