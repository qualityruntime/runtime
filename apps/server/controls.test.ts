// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The control resource, over HTTP, against a migrated database.
 *
 * Authentication and membership are `organization.test.ts`'s subject; here a
 * member is assumed and what is tested is the resource: its shape, its
 * validation, its lifecycle rule, and that another organization's control is
 * invisible rather than forbidden.
 *
 * Requests run as a non-superuser role that owns the tables, with row-level
 * security forced so the policies bind their owner. That exercises the
 * policies; the deployment's own posture — a runtime role that owns nothing —
 * is `privileges.test.ts` and `documented-setup.test.ts`.
 */

import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { eq, sql } from "drizzle-orm";
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
let acme: { cookie: string; organizationId: string };
let globex: { cookie: string; organizationId: string };

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Control = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: string;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Failure = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

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

  const tenant = async (slug: string) => {
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
    set role qualityruntime_app;
  `);
}, 60_000);

/** A request as a member of `tenant`, to that tenant's controls. */
const request = (
  tenant: { cookie: string; organizationId: string },
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}/controls${path}`, {
    ...init,
    // Merged, not replaced: a caller's own headers are the point of passing
    // them, and dropping them silently makes a test pass for the wrong reason.
    headers: {
      cookie: tenant.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const create = (tenant: { cookie: string; organizationId: string }, body: unknown) =>
  request(tenant, "", { method: "POST", body: JSON.stringify(body) });

const patch = (tenant: { cookie: string; organizationId: string }, id: string, body: unknown) =>
  request(tenant, `/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const discard = (tenant: { cookie: string; organizationId: string }, id: string) =>
  request(tenant, `/${id}`, { method: "DELETE" });

/** Creates a control and returns it, failing the test if that did not work. */
async function given(
  tenant: { cookie: string; organizationId: string },
  body: unknown = { name: "Access review" },
): Promise<Control> {
  const response = await create(tenant, body);
  expect(response.status).toBe(201);
  return (await json<{ data: Control }>(response)).data;
}

describe("creating a control", () => {
  it("returns 201 and the stored control", async () => {
    const response = await create(acme, { name: "Quarterly access review" });

    expect(response.status).toBe(201);
    const { data } = await json<{ data: Control }>(response);
    expect(data.id).toMatch(/^ctl_[0-9a-z]{16}$/);
    expect(data.name).toBe("Quarterly access review");
    expect(data.description).toBeNull();
    expect(data.organizationId).toBe(acme.organizationId);
  });

  it("starts every control as a draft, whatever the body asks for", async () => {
    // Status is not part of the create contract: a control is authored first
    // and put into effect deliberately.
    const data = await given(acme, { name: "Backup restore test", status: "active" });

    expect(data.status).toBe("draft");
  });

  it("files the control under the organization in the path, not one in the body", async () => {
    const data = await given(acme, {
      name: "Planted",
      organizationId: globex.organizationId,
    });

    expect(data.organizationId).toBe(acme.organizationId);
  });

  it("trims a name and keeps the trimmed form", async () => {
    const data = await given(acme, { name: "  Padded  " });

    expect(data.name).toBe("Padded");
  });

  it("returns exactly the documented fields", async () => {
    // A guard on the contract: a column added to the table starts appearing
    // here silently otherwise.
    const data = await given(acme);

    expect(Object.keys(data).sort()).toEqual([
      "activatedAt",
      "createdAt",
      "description",
      "id",
      "name",
      "organizationId",
      "status",
      "updatedAt",
    ]);
  });

  it.each([
    ["a missing name", {}],
    ["a blank name", { name: "   " }],
    ["a name that is not a string", { name: 42 }],
    ["a name beyond the length bound", { name: "x".repeat(201) }],
  ])("refuses %s", async (_case, body) => {
    const response = await create(acme, body);

    expect(response.status).toBe(400);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("invalid_request");
    expect(error.details?.map((detail) => detail.path)).toContain("name");
  });

  it("refuses a NUL character rather than failing the statement", async () => {
    // PostgreSQL rejects NUL in `text` outright, so without this the driver
    // raises and the caller sees a 500 for what is a bad request.
    const response = await create(acme, { name: `a${String.fromCharCode(0)}b` });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses a body larger than the limit without parsing it", async () => {
    const response = await request(acme, "", {
      method: "POST",
      body: JSON.stringify({ name: "Fine", padding: "x".repeat(100_000) }),
    });

    expect(response.status).toBe(413);
    expect((await json<Failure>(response)).error.code).toBe("payload_too_large");
  });

  it("refuses a malformed body in the same shape as everything else", async () => {
    const response = await request(acme, "", { method: "POST", body: "{not json" });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });
});

describe("reading a control", () => {
  it("returns one by id", async () => {
    const created = await given(acme, { name: "Supplier audit" });

    const response = await request(acme, `/${created.id}`);

    expect(response.status).toBe(200);
    expect((await json<{ data: Control }>(response)).data).toEqual(created);
  });

  it("lists newest first", async () => {
    const own = await tenantWithControls(["First", "Second", "Third"]);

    const { data } = await json<{ data: Control[] }>(await request(own, ""));

    expect(data.map((row) => row.name)).toEqual(["Third", "Second", "First"]);
  });

  it("answers 404 for an id that does not exist", async () => {
    const response = await request(acme, "/ctl_0000000000000000");

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
  });

  it.each([
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "org_v1stgxr8z5jdhi6b"],
    ["a percent-encoded NUL", "%00"],
  ])("answers 404 for %s", async (_case, id) => {
    // The last one would otherwise reach PostgreSQL and fail the statement.
    const response = await request(acme, `/${id}`);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
  });

  it("answers 404 for another organization's control, not 403", async () => {
    // The policy makes it invisible, so this is not a special case in the
    // handler — and a member of Acme cannot learn that the id is real.
    const theirs = await given(globex, { name: "Globex only" });

    const response = await request(acme, `/${theirs.id}`);
    const absent = await request(acme, "/ctl_0000000000000000");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(await json(absent));
  });
});

describe("updating a control", () => {
  it("changes the fields it is given and leaves the rest", async () => {
    const created = await given(acme, { name: "Before", description: "Original" });

    const response = await patch(acme, created.id, { name: "After" });

    expect(response.status).toBe(200);
    const { data } = await json<{ data: Control }>(response);
    expect(data.name).toBe("After");
    expect(data.description).toBe("Original");
    expect(data.id).toBe(created.id);
  });

  it("clears a description when explicitly given null", async () => {
    const created = await given(acme, { name: "Describable", description: "Original" });

    const { data } = await json<{ data: Control }>(
      await patch(acme, created.id, { description: null }),
    );

    expect(data.description).toBeNull();
  });

  it("advances the updated timestamp", async () => {
    const created = await given(acme, { name: "Touched" });
    // Backdated in SQL so the assertion can be strict without waiting on a
    // clock: written directly, `$onUpdate` never sees it.
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "control" set updated_at = now() - interval '1 day' where id = ${created.id}`,
      ),
    );
    const { data: stale } = await json<{ data: Control }>(await request(acme, `/${created.id}`));

    const { data } = await json<{ data: Control }>(
      await patch(acme, created.id, { name: "Moved" }),
    );

    expect(Date.parse(data.updatedAt)).toBeGreaterThan(Date.parse(stale.updatedAt));
    expect(data.createdAt).toBe(created.createdAt);
  });

  it("refuses a body that asks for no change", async () => {
    const created = await given(acme);

    const response = await patch(acme, created.id, {});

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses to change the organization", async () => {
    // Not a field of the update contract, so it is dropped rather than applied.
    const created = await given(acme, { name: "Stays put" });

    const { data } = await json<{ data: Control }>(
      await patch(acme, created.id, { name: "Stays put", organizationId: globex.organizationId }),
    );

    expect(data.organizationId).toBe(acme.organizationId);
  });

  it("answers 404 for another organization's control", async () => {
    const theirs = await given(globex, { name: "Globex only" });

    const response = await patch(acme, theirs.id, { name: "Hijacked" });

    expect(response.status).toBe(404);
  });
});

describe("the control lifecycle", () => {
  const advance = async (to: string, through: string[] = []) => {
    const created = await given(acme, { name: `To ${to}` });
    for (const step of through)
      expect((await patch(acme, created.id, { status: step })).status).toBe(200);
    return created;
  };

  it.each([
    ["draft to active", [], "active"],
    ["active to retired", ["active"], "retired"],
  ])("allows %s", async (_case, through, to) => {
    const created = await advance(to, through);

    const response = await patch(acme, created.id, { status: to });

    expect(response.status).toBe(200);
    expect((await json<{ data: Control }>(response)).data.status).toBe(to);
  });

  it.each([
    ["draft straight to retired", [], "retired"],
    ["active back to draft", ["active"], "draft"],
    ["retired back to active", ["active", "retired"], "active"],
    ["retired back to draft", ["active", "retired"], "draft"],
  ])("refuses %s", async (_case, through, to) => {
    const created = await advance(to, through);

    const response = await patch(acme, created.id, { status: to });

    expect(response.status).toBe(409);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("invalid_transition");
  });

  it("allows setting the status a control already has, and writes nothing", async () => {
    // A no-op must not move the version: another client's tag would go stale
    // while history said nothing happened.
    const created = await given(acme, { name: "Unchanged" });
    const read = await request(acme, `/${created.id}`);

    const response = await patch(acme, created.id, { status: "draft", name: "Unchanged" });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(read.headers.get("etag"));
    const { data } = await json<{ data: Control }>(response);
    expect(data.updatedAt).toBe((await json<{ data: Control }>(read)).data.updatedAt);
  });

  it("refuses a status outside the lifecycle", async () => {
    const created = await given(acme);

    const response = await patch(acme, created.id, { status: "approved" });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("leaves the control untouched when a transition is refused", async () => {
    const created = await given(acme, { name: "Original name" });

    await patch(acme, created.id, { name: "Renamed", status: "retired" });

    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.name).toBe("Original name");
    expect(data.status).toBe("draft");
  });
});

/** A fresh organization holding exactly `names`, so ordering tests stand alone. */
async function tenantWithControls(names: string[]) {
  const slug = `list-${names.length}-${Math.random().toString(36).slice(2, 8)}`;
  const signedUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: `${slug}@example.test`, password: "correct horse" }),
  });
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const created = await app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: slug, slug }),
  });
  const tenant = { cookie, organizationId: (await json<{ id: string }>(created)).id };

  for (const name of names) await given(tenant, { name });
  return tenant;
}

describe("discarding a draft", () => {
  it("says what to do instead of reviving a retired control", async () => {
    // Retired is final, so a retired control never becomes a draft that could
    // be discarded: what replaces it is a new control.
    const created = await given(acme, { name: "Was in effect" });
    for (const step of ["active", "retired"]) {
      expect((await patch(acme, created.id, { status: step })).status).toBe(200);
    }

    const response = await patch(acme, created.id, { status: "draft" });

    expect(response.status).toBe(409);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("invalid_transition");
    expect(error.details?.[0]?.message).toContain("author a new one instead");
  });

  it("will not let the column that decides this be cleared", async () => {
    // A draft is tied to a null `activated_at`, so anything able to clear it
    // could turn a control that was in effect into a deletable draft. A policy
    // cannot prevent that — `WITH CHECK` sees only the new row — so a trigger
    // does.
    const created = await given(acme, { name: "Tamper with the evidence of it" });
    expect((await patch(acme, created.id, { status: "active" })).status).toBe(200);

    const error = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.control)
        .set({ status: "draft", activatedAt: null })
        .where(eq(schema.control.id, created.id)),
    ).then(
      () => null,
      (thrown: Error) => thrown,
    );

    const reason = error?.cause instanceof Error ? error.cause.message : error?.message;
    expect(reason).toMatch(/set by the database/);
    // And so the control is still undeletable.
    const removed = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.control).where(eq(schema.control.id, created.id)).returning(),
    );
    expect(removed).toEqual([]);
  });

  it("keeps when a control took effect after it is retired", async () => {
    // Set once: retiring a control ends it, and does not rewrite when it began.
    const created = await given(acme, { name: "Activated, then retired" });
    expect((await patch(acme, created.id, { status: "active" })).status).toBe(200);
    const first = (await json<{ data: Control }>(await request(acme, `/${created.id}`))).data
      .activatedAt;
    expect(first).not.toBeNull();

    expect((await patch(acme, created.id, { status: "retired" })).status).toBe(200);

    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.activatedAt).toBe(first);
  });

  it("records it even when the API is not what activated the control", async () => {
    // The trigger assigns it, so no code path can activate a control without
    // leaving the record that makes it undeletable.
    const created = await given(acme, { name: "Activated in SQL" });

    const [row] = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.control)
        .set({ status: "active" })
        .where(eq(schema.control.id, created.id))
        .returning(),
    );

    expect(row?.activatedAt).not.toBeNull();
  });

  it("will not let the database turn one that was in effect back into a draft", async () => {
    // The route refuses the move; this is raw SQL, which the policy would then
    // let delete a draft. The stamp survives, and a draft may not carry one.
    const created = await given(acme, { name: "Laundered in SQL" });
    expect((await patch(acme, created.id, { status: "active" })).status).toBe(200);

    const redrafting = withOrganization(db, acme.organizationId, (tx) =>
      tx.update(schema.control).set({ status: "draft" }).where(eq(schema.control.id, created.id)),
    );

    await expect(redrafting).rejects.toMatchObject({
      cause: { constraint: "control_took_effect_unless_draft" },
    });
  });

  /** A control at `status`, moved there through the lifecycle. */
  const at = async (status: "draft" | "active" | "retired") => {
    const created = await given(acme, { name: `A ${status} one` });
    for (const step of { draft: [], active: ["active"], retired: ["active", "retired"] }[status]) {
      expect((await patch(acme, created.id, { status: step })).status).toBe(200);
    }
    return created;
  };

  it("removes a draft nobody wants, which is the only way to be rid of one", async () => {
    // The lifecycle has no `draft → retired`, so before this an abandoned draft
    // could only be disposed of by first putting it into effect (ADR 0017).
    const created = await at("draft");

    const response = await discard(acme, created.id);

    expect(response.status).toBe(204);
    expect((await request(acme, `/${created.id}`)).status).toBe(404);
  });

  it.each([
    ["active", "Retire it instead"],
    ["retired", "part of the record"],
  ])("refuses to remove a %s control, and says what to do", async (status, advice) => {
    const created = await at(status as "active" | "retired");

    const response = await discard(acme, created.id);

    expect(response.status).toBe(409);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("was_in_effect");
    expect(error.details?.[0]?.message).toContain(advice);
    // Still there, and still what it was.
    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.status).toBe(status);
  });

  it("will not let the database remove one either", async () => {
    // The route is the courteous answer; the policy is the guarantee. A
    // statement sent inside the tenant's own context matches nothing.
    const created = await at("active");

    const removed = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.control).where(eq(schema.control.id, created.id)).returning(),
    );

    expect(removed).toEqual([]);
  });

  it("cannot be marked retired behind the API's back", async () => {
    // Retired means no longer in effect, so a control that never was cannot
    // be: only a draft may lack the stamp.
    const created = await given(acme, { name: "Retired without effect" });

    const retiring = withOrganization(db, acme.organizationId, (tx) =>
      tx.update(schema.control).set({ status: "retired" }).where(eq(schema.control.id, created.id)),
    );

    await expect(retiring).rejects.toMatchObject({
      cause: { constraint: "control_took_effect_unless_draft" },
    });
    expect((await discard(acme, created.id)).status).toBe(204);
  });

  it("will not let the database remove one made active behind the API's back", async () => {
    // Raw SQL rather than the route, and nothing sets the column: the trigger
    // stamps the control on becoming active whoever does it, so the DELETE
    // policy refuses it all the same.
    const created = await given(acme, { name: "Active without a record of it" });

    const removed = await withOrganization(db, acme.organizationId, async (tx) => {
      await tx
        .update(schema.control)
        .set({ status: "active" })
        .where(eq(schema.control.id, created.id));
      return tx.delete(schema.control).where(eq(schema.control.id, created.id)).returning();
    });

    expect(removed).toEqual([]);
  });

  it("will not let the database remove a retired one either", async () => {
    // `retired` is a separate row state from `active`, and a predicate that
    // named only one of them would pass the test above.
    const created = await at("retired");

    const removed = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.control).where(eq(schema.control.id, created.id)).returning(),
    );

    expect(removed).toEqual([]);
  });

  it("answers 404 for another organization's draft, and leaves it alone", async () => {
    const theirs = await given(globex, { name: "Theirs" });

    const response = await discard(acme, theirs.id);

    expect(response.status).toBe(404);
    // The route's own answer, not Hono's for an unrouted method: those are
    // both 404 and only the body tells them apart.
    expect((await json<Failure>(response)).error.message).toBe("No such control.");
    expect((await request(globex, `/${theirs.id}`)).status).toBe(200);
  });

  it("keeps the history of a control it removed", async () => {
    // `resource_id` is a plain column, not a reference, so history outlives
    // what it describes — which is the whole point of an append-only log.
    const created = await given(acme, { name: "Short-lived" });
    await discard(acme, created.id);

    const events = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.auditEvent).where(eq(schema.auditEvent.resourceId, created.id)),
    );

    expect(events.map((event) => event.action).sort()).toEqual(["created", "deleted"]);
    const deletion = events.find((event) => event.action === "deleted");
    // Everything audited, not merely the fields this assertion happens to name.
    expect(deletion?.before).toEqual({
      name: "Short-lived",
      description: null,
      status: "draft",
    });
    // Nothing is left to describe, so nothing is claimed.
    expect(deletion?.after).toBeNull();
  });

  it("refuses a draft that carries evidence, rather than failing on a foreign key", async () => {
    const created = await given(acme, { name: "Has evidence" });
    const recorded = await app.request(
      `/api/v1/organizations/${acme.organizationId}/controls/${created.id}/evidence`,
      {
        method: "POST",
        headers: { cookie: acme.cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
      },
    );
    expect(recorded.status).toBe(201);

    const response = await discard(acme, created.id);

    expect(response.status).toBe(409);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("has_evidence");
    expect(error.details?.[0]?.message).toContain("Discard its evidence first");
    expect((await request(acme, `/${created.id}`)).status).toBe(200);
  });

  it("answers 404 for an id of the wrong shape, a NUL included", async () => {
    // An id is checked against the shape PostgreSQL enforces before it is used:
    // a NUL in `text` fails the statement, which would otherwise be a 500 for
    // what is plainly an absence.
    const malformed = await discard(acme, "not-an-id");
    const nul = await discard(acme, encodeURIComponent("ctl_v1stgxr8z5jdhi6\u0000"));

    expect(malformed.status).toBe(404);
    expect((await json<Failure>(malformed)).error.message).toBe("No such control.");
    expect(nul.status).toBe(404);
  });
});

describe("changing only what you read", () => {
  /** The control's current entity tag, as a client would obtain it. */
  const tagOf = async (id: string) => {
    const response = await request(acme, `/${id}`);
    expect(response.status).toBe(200);
    return response.headers.get("etag")!;
  };

  const patchWith = (id: string, tag: string | undefined, body: unknown) =>
    request(acme, `/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      ...(tag ? { headers: { "if-match": tag } } : {}),
    });

  it("serves a tag that changes when the control does", async () => {
    const created = await given(acme, { name: "Versioned" });
    const first = await tagOf(created.id);

    expect((await patchWith(created.id, undefined, { name: "Renamed" })).status).toBe(200);

    expect(first).toMatch(/^"\d+"$/);
    expect(await tagOf(created.id)).not.toBe(first);
  });

  it("refuses a change against a version that has moved", async () => {
    // What last-writer-wins looks like from the loser's side: two people read
    // the same control, and the second write silently discarded the first
    // until this (ADR 0019).
    const created = await given(acme, { name: "Contested" });
    const read = await tagOf(created.id);
    expect((await patchWith(created.id, read, { name: "First wins" })).status).toBe(200);

    const late = await patchWith(created.id, read, { name: "Second, unaware" });

    expect(late.status).toBe(412);
    expect((await json<Failure>(late)).error.code).toBe("precondition_failed");
    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.name).toBe("First wins");
  });

  it("allows a change against the version just read", async () => {
    const created = await given(acme, { name: "Agreed" });

    const response = await patchWith(created.id, await tagOf(created.id), { name: "Changed" });

    expect(response.status).toBe(200);
    // The answer carries the new tag, so a client can chain edits without
    // reading again.
    expect(response.headers.get("etag")).toBe(await tagOf(created.id));
  });

  it("changes nothing when it refuses", async () => {
    const created = await given(acme, { name: "Untouched" });

    expect((await patchWith(created.id, '"0"', { status: "active" })).status).toBe(412);

    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.name).toBe("Untouched");
    expect(data.status).toBe("draft");
    expect(data.activatedAt).toBeNull();
  });

  it("takes a star to mean only if it is still there", async () => {
    const created = await given(acme, { name: "Any version" });

    const response = await patchWith(created.id, "*", { name: "Whatever it was" });

    expect(response.status).toBe(200);
  });

  it("refuses a discard against a version that has moved", async () => {
    // Discarding is not undoable, so this is the one worth being sure of.
    const created = await given(acme, { name: "About to go" });
    const read = await tagOf(created.id);
    expect((await patchWith(created.id, read, { name: "Changed underneath" })).status).toBe(200);

    const stale = await request(acme, `/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": read },
    });

    expect(stale.status).toBe(412);
    expect((await request(acme, `/${created.id}`)).status).toBe(200);
  });

  it("discards against the version just read", async () => {
    const created = await given(acme, { name: "Agreed to go" });

    const gone = await request(acme, `/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": await tagOf(created.id) },
    });

    expect(gone.status).toBe(204);
  });

  it.each([
    ["a control that has been in effect", "was_in_effect"],
    ["a control carrying evidence", "has_evidence"],
  ])("says why %s cannot be discarded, whatever the tag says", async (_case, code) => {
    // A precondition answers a request that would otherwise have succeeded
    // (RFC 9110 §13.2.1). Asking first would make a refused request disclose
    // whether the caller's tag matched, which is both wrong and a leak.
    const created = await given(acme, { name: `Refused: ${code}` });
    if (code === "was_in_effect") {
      expect((await patchWith(created.id, undefined, { status: "active" })).status).toBe(200);
    } else {
      const recorded = await app.request(
        `/api/v1/organizations/${acme.organizationId}/controls/${created.id}/evidence`,
        {
          method: "POST",
          headers: { cookie: acme.cookie, "content-type": "application/json" },
          body: JSON.stringify({ title: "Attached", occurredAt: "2026-07-01T09:00:00.000Z" }),
        },
      );
      expect(recorded.status).toBe(201);
    }

    const stale = await request(acme, `/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": '"0"' },
    });
    const current = await request(acme, `/${created.id}`, {
      method: "DELETE",
      headers: { "if-match": await tagOf(created.id) },
    });

    // The same answer either way: the tag tells the caller nothing.
    expect(stale.status).toBe(409);
    expect(current.status).toBe(409);
    expect((await json<Failure>(stale)).error.code).toBe(code);
  });

  it("says a transition is illegal rather than that the tag is stale", async () => {
    const created = await given(acme, { name: "Illegal and stale" });
    const read = await tagOf(created.id);
    expect((await patchWith(created.id, undefined, { name: "Moved on" })).status).toBe(200);

    const both = await patchWith(created.id, read, { status: "retired" });

    expect(both.status).toBe(409);
    expect((await json<Failure>(both)).error.code).toBe("invalid_transition");
  });

  it("goes on working for a client that asks for no guarantee", async () => {
    // Optional, so a simple client is not broken by this existing.
    const created = await given(acme, { name: "Unconditional" });

    expect((await patchWith(created.id, undefined, { name: "Fine" })).status).toBe(200);
    expect((await request(acme, `/${created.id}`, { method: "DELETE" })).status).toBe(204);
  });
});
