// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mapping controls to the requirements they answer to.
 *
 * `PUT` replaces the whole set, so most of what is checked here is that saying
 * the same thing twice changes nothing — in the rows, and in the history.
 * Requests run as a non-superuser role that owns the tables, so the row-level
 * security policies are in force as they are in a deployment.
 */

import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { inMemoryObjectStore } from "./s3-in-memory.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;

/** Acme's requirements, in the order their standard states them. */
let requirements: { id: string; reference: string }[];
let theirRequirement: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Page<T> = { data: T[]; nextCursor: string | null };
type Failure = { error: { code: string; details?: { path: string; message: string }[] } };

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

async function newControl(tenant: Tenant, name: string): Promise<string> {
  const response = await request(tenant, "/controls", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

const setRequirements = (tenant: Tenant, controlId: string, requirementIds: string[]) =>
  request(tenant, `/controls/${controlId}/requirements`, {
    method: "PUT",
    body: JSON.stringify({ requirementIds }),
  });

const listRequirements = async (tenant: Tenant, controlId: string, query = "") =>
  json<Page<{ id: string; reference: string; standardId: string }>>(
    await request(tenant, `/controls/${controlId}/requirements${query}`),
  );

/** Every audit event recorded against a control. */
const historyOf = (tenant: Tenant, controlId: string) =>
  withOrganization(db, tenant.organizationId, (tx) =>
    tx
      .select()
      .from(schema.auditEvent)
      .where(
        and(
          eq(schema.auditEvent.resourceType, "control"),
          eq(schema.auditEvent.resourceId, controlId),
        ),
      ),
  );

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  app = createApp({
    db,
    store: inMemoryObjectStore().store,
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
    alter table "control_requirement" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);

  const importStandard = async (tenant: Tenant, count: number) => {
    const response = await request(tenant, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 9001",
        edition: "2015",
        requirements: Array.from({ length: count }, (_, index) => ({
          reference: `7.${index + 1}`,
          title: `Clause ${index + 1}`,
        })),
      }),
    });
    expect(response.status).toBe(201);
    const { id } = (await json<{ data: { id: string } }>(response)).data;
    const { data } = await listStandardRequirements(tenant, id);
    return data;
  };
  const listStandardRequirements = async (tenant: Tenant, standardId: string) =>
    json<Page<{ id: string; reference: string }>>(
      await request(tenant, `/standards/${standardId}/requirements?limit=100`),
    );

  requirements = await importStandard(acme, 5);
  theirRequirement = (await importStandard(globex, 1))[0]!.id;
}, 60_000);

describe("setting what a control answers to", () => {
  it("returns the set it was given, sorted", async () => {
    const control = await newControl(acme, "Access review");
    const ids = [requirements[2]!.id, requirements[0]!.id];

    const response = await setRequirements(acme, control, ids);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: { requirementIds: string[] } }>(response);
    expect(data.requirementIds).toEqual([...ids].sort());
  });

  it("maps a retired control too, as it may be renamed", async () => {
    // Deliberate: retiring freezes nothing else on a control, so freezing only
    // its mappings would be a rule of its own (ADR 0010).
    const control = await newControl(acme, "Retired");
    for (const status of ["active", "retired"]) {
      const changed = await request(acme, `/controls/${control}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      expect(changed.status).toBe(200);
    }

    const response = await setRequirements(acme, control, [requirements[0]!.id]);

    expect(response.status).toBe(200);
  });

  it("replaces the set rather than adding to it", async () => {
    const control = await newControl(acme, "Replaced");
    await setRequirements(acme, control, [requirements[0]!.id, requirements[1]!.id]);

    await setRequirements(acme, control, [requirements[1]!.id, requirements[2]!.id]);

    const { data } = await listRequirements(acme, control);
    expect(data.map((row) => row.reference)).toEqual(["7.2", "7.3"]);
  });

  it("clears the set when given an empty array", async () => {
    const control = await newControl(acme, "Cleared");
    await setRequirements(acme, control, [requirements[0]!.id]);

    expect((await setRequirements(acme, control, [])).status).toBe(200);

    expect((await listRequirements(acme, control)).data).toEqual([]);
  });

  it("treats a repeated identifier as one", async () => {
    const control = await newControl(acme, "Repeated");

    const response = await setRequirements(acme, control, [
      requirements[0]!.id,
      requirements[0]!.id,
    ]);

    expect(response.status).toBe(200);
    expect(
      (await json<{ data: { requirementIds: string[] } }>(response)).data.requirementIds,
    ).toEqual([requirements[0]!.id]);
    expect((await listRequirements(acme, control)).data).toHaveLength(1);
  });

  it("changes nothing when asked for what is already there", async () => {
    const control = await newControl(acme, "Idempotent");
    const ids = [requirements[0]!.id, requirements[1]!.id];
    await setRequirements(acme, control, ids);
    const before = await historyOf(acme, control);

    expect((await setRequirements(acme, control, [...ids].reverse())).status).toBe(200);

    // Same set, said differently: no rows moved, and nothing to record.
    expect(await historyOf(acme, control)).toEqual(before);
  });

  it("records the change on the control, as one event", async () => {
    const control = await newControl(acme, "Audited");

    await setRequirements(acme, control, [requirements[0]!.id]);
    await setRequirements(acme, control, [requirements[1]!.id]);

    const history = await historyOf(acme, control);
    expect(history.map((event) => event.action)).toEqual(["created", "updated", "updated"]);
    expect(history.at(-1)).toMatchObject({
      before: { requirementIds: [requirements[0]!.id] },
      after: { requirementIds: [requirements[1]!.id] },
    });
  });
});

describe("requirements a control cannot answer to", () => {
  it("names a requirement that does not exist", async () => {
    const control = await newControl(acme, "Unknown");

    const response = await setRequirements(acme, control, [
      requirements[0]!.id,
      "req_0000000000000000",
    ]);

    expect(response.status).toBe(400);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("invalid_request");
    expect(error.details?.[0]?.message).toContain("req_0000000000000000");
  });

  it("refuses another organization's requirement the same way", async () => {
    // The foreign key would refuse it too, as a 500; and the answer must not
    // distinguish a requirement that is elsewhere from one that is nowhere.
    const control = await newControl(acme, "Cross tenant");

    const response = await setRequirements(acme, control, [theirRequirement]);
    const absent = await setRequirements(acme, control, ["req_0000000000000000"]);

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe(
      (await json<Failure>(absent)).error.code,
    );
  });

  it("writes nothing when one requirement in the set is unknown", async () => {
    const control = await newControl(acme, "All or nothing");
    await setRequirements(acme, control, [requirements[0]!.id]);

    await setRequirements(acme, control, [requirements[1]!.id, "req_0000000000000000"]);

    const { data } = await listRequirements(acme, control);
    expect(data.map((row) => row.reference)).toEqual(["7.1"]);
  });

  it.each([
    ["a requirement id of the wrong shape", ["not-an-id"]],
    ["an id carrying another table's prefix", ["ctl_v1stgxr8z5jdhi6b"]],
  ])("refuses %s", async (_case, ids) => {
    const control = await newControl(acme, `Bad ${ids[0]}`);

    expect((await setRequirements(acme, control, ids)).status).toBe(400);
  });

  it("answers 404 for a control that is not there", async () => {
    const response = await setRequirements(acme, "ctl_0000000000000000", []);

    expect(response.status).toBe(404);
  });
});

describe("reading what a control answers to", () => {
  it("lists them in the order their standard states", async () => {
    const control = await newControl(acme, "Ordered");
    // Given out of order, and out of order lexically: 7.10 before 7.9.
    await setRequirements(acme, control, [
      requirements[4]!.id,
      requirements[0]!.id,
      requirements[2]!.id,
    ]);

    const { data } = await listRequirements(acme, control);

    expect(data.map((row) => row.reference)).toEqual(["7.1", "7.3", "7.5"]);
  });

  it("pages like every other collection", async () => {
    const control = await newControl(acme, "Paged");
    await setRequirements(
      acme,
      control,
      requirements.map((row) => row.id),
    );

    const first = await listRequirements(acme, control, "?limit=2");
    expect(first.nextCursor).not.toBeNull();
    const second = await listRequirements(
      acme,
      control,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );

    expect(first.data.map((row) => row.reference)).toEqual(["7.1", "7.2"]);
    expect(second.data.map((row) => row.reference)).toEqual(["7.3", "7.4"]);
  });

  it("carries the standard each requirement comes from", async () => {
    const control = await newControl(acme, "Grouped");
    await setRequirements(acme, control, [requirements[0]!.id]);

    const { data } = await listRequirements(acme, control);

    expect(data[0]?.standardId).toMatch(/^std_[0-9a-z]{16}$/);
  });

  it("answers 404 for another organization's control", async () => {
    const theirs = await newControl(globex, "Globex only");

    expect((await request(acme, `/controls/${theirs}/requirements`)).status).toBe(404);
  });
});

describe("what deletion does to a mapping", () => {
  it("forgets the link when the requirement's standard goes", async () => {
    // Nothing deletes a standard over HTTP yet, so this is the database's
    // cascade rather than a route — but a control must not be left answering
    // to a requirement that is gone.
    const control = await newControl(acme, "Orphaned");
    const [standard] = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .insert(schema.standard)
        .values({ organizationId: acme.organizationId, name: "Temporary", edition: "1" })
        .returning(),
    );
    const [requirement] = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .insert(schema.requirement)
        .values({
          organizationId: acme.organizationId,
          standardId: standard!.id,
          reference: "1",
          title: "Only clause",
          position: 1,
        })
        .returning(),
    );
    await setRequirements(acme, control, [requirement!.id]);
    expect((await listRequirements(acme, control)).data).toHaveLength(1);

    await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.standard).where(eq(schema.standard.id, standard!.id)),
    );

    expect((await listRequirements(acme, control)).data).toEqual([]);
  });
});

describe("setting only the requirements you read", () => {
  /** The current version of a control's mapping set, as a client obtains it. */
  const tagOf = async (controlId: string) => {
    const response = await request(acme, `/controls/${controlId}/requirements`);
    expect(response.status).toBe(200);
    return response.headers.get("etag")!;
  };

  const setWith = (controlId: string, tag: string | undefined, requirementIds: string[]) =>
    request(acme, `/controls/${controlId}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds }),
      ...(tag ? { headers: { "if-match": tag } } : {}),
    });

  it("serves a version that follows the set, not the order it is written in", async () => {
    // A set is its members: the same two requirements are the same set however
    // a client lists them, and a tag that disagreed would refuse a write that
    // changed nothing (ADR 0019).
    const control = await newControl(acme, "Versioned mapping");
    const pair = [requirements[0]!.id, requirements[1]!.id];

    expect((await setWith(control, undefined, pair)).status).toBe(200);
    const forward = await tagOf(control);
    expect((await setWith(control, undefined, [...pair].reverse())).status).toBe(200);

    expect(await tagOf(control)).toBe(forward);
    expect(forward).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("changes the version when the set changes, and not otherwise", async () => {
    const control = await newControl(acme, "Changing mapping");
    expect((await setWith(control, undefined, [requirements[0]!.id])).status).toBe(200);
    const one = await tagOf(control);

    expect((await setWith(control, undefined, [requirements[1]!.id])).status).toBe(200);
    const other = await tagOf(control);
    expect(other).not.toBe(one);

    // An empty set is a set, and has a version of its own.
    expect((await setWith(control, undefined, [])).status).toBe(200);
    expect(await tagOf(control)).not.toBe(other);
  });

  it("refuses a replacement against a set that has moved", async () => {
    // What last-writer-wins looked like here: the second write removed a
    // mapping the first had added, and neither client learned anything
    // (ADR 0010).
    const control = await newControl(acme, "Contested mapping");
    const read = await tagOf(control);
    expect((await setWith(control, read, [requirements[0]!.id])).status).toBe(200);

    const late = await setWith(control, read, [requirements[1]!.id]);

    expect(late.status).toBe(412);
    expect((await json<Failure>(late)).error.code).toBe("precondition_failed");
    const { data } = await listRequirements(acme, control);
    expect(data.map((row) => row.id)).toEqual([requirements[0]!.id]);
  });

  it("allows a replacement against the set just read, and answers with the new version", async () => {
    const control = await newControl(acme, "Agreed mapping");

    const response = await setWith(control, await tagOf(control), [requirements[0]!.id]);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(await tagOf(control));
  });

  it("carries the whole set's version on every page of it", async () => {
    // The page is a window on the set; the version is the set's. A client that
    // paged through and then wrote must be writing against what it read.
    const control = await newControl(acme, "Paged mapping");
    expect(
      (
        await setWith(
          control,
          undefined,
          requirements.slice(0, 2).map((row) => row.id),
        )
      ).status,
    ).toBe(200);

    const first = await request(acme, `/controls/${control}/requirements?limit=1`);
    const tag = first.headers.get("etag");
    const { nextCursor } = await json<Page<{ id: string }>>(first);
    expect(nextCursor).not.toBeNull();
    const second = await request(
      acme,
      `/controls/${control}/requirements?limit=1&cursor=${encodeURIComponent(nextCursor!)}`,
    );

    expect(second.headers.get("etag")).toBe(tag);
  });

  it("goes on working for a client that asks for no guarantee", async () => {
    const control = await newControl(acme, "Unconditional mapping");

    expect((await setWith(control, undefined, [requirements[0]!.id])).status).toBe(200);
  });
});
