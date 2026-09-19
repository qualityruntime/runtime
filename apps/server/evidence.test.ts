// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Recording evidence, and what attesting it settles.
 *
 * Evidence is the first finalised record here (VERSION-01), so the tests that
 * matter most are the ones that go round the routes: an attested row is not
 * changeable through a tenant context at all, whatever the application asks.
 * Requests run as a non-superuser role that owns the tables, so the policies
 * are in force as they are in a deployment.
 */

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { fileStoreOnDisk } from "./storage-on-disk.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/** The volume this run's store writes to, so its contents can be counted. */
let directory: string;

/** A store of its own, thrown away with the run. */
const temporaryStore = async () => {
  directory = await mkdtemp(join(tmpdir(), "qualityruntime-"));
  return fileStoreOnDisk(directory);
};

/** Every file under `root`, as paths relative to it. */
async function leaves(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await leaves(root, path)));
    else found.push(path);
  }
  return found;
}

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;

type Tenant = { cookie: string; organizationId: string; userId: string };
let acme: Tenant;
let globex: Tenant;
let control: string;
let theirControl: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Attestation = { at: string; by: { id: string; label: string | null } } | null;
type Evidence = {
  id: string;
  title: string;
  description: string | null;
  occurredAt: string;
  attestation: Attestation;
};
type Page<T> = { data: T[]; nextCursor: string | null };
type Failure = {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
};

type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: {
      cookie: tenant.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      // Merged, not replaced: an attestation carries `if-match`.
      ...init.headers,
    },
  });

async function record(
  tenant: Tenant,
  controlId: string,
  body: Record<string, unknown> = {},
): Promise<Evidence> {
  const response = await request(tenant, `/controls/${controlId}/evidence`, {
    method: "POST",
    body: JSON.stringify({
      title: "Q3 access review",
      occurredAt: "2026-07-01T09:00:00.000Z",
      ...body,
    }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: Evidence }>(response)).data;
}

/** Signs a user up and returns their identifier. */
async function signUp(email: string): Promise<string> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Grace Hopper", email, password: "correct horse" }),
  });
  expect(response.status).toBe(200);
  return (await json<{ user: { id: string } }>(response)).user.id;
}

/** Reads the evidence, then attests exactly what it read. */
async function attest(tenant: Tenant, id: string, ifMatch?: string) {
  const tag = ifMatch ?? (await request(tenant, `/evidence/${id}`)).headers.get("etag") ?? "";
  return request(tenant, `/evidence/${id}/attestation`, {
    method: "PUT",
    headers: { "if-match": tag },
  });
}

const amend = (tenant: Tenant, id: string, body: unknown) =>
  request(tenant, `/evidence/${id}`, { method: "PATCH", body: JSON.stringify(body) });

const discard = (tenant: Tenant, id: string) =>
  request(tenant, `/evidence/${id}`, { method: "DELETE" });

/** Every audit event recorded against one piece of evidence. */
const historyOf = (tenant: Tenant, id: string) =>
  withOrganization(db, tenant.organizationId, (tx) =>
    tx
      .select()
      .from(schema.auditEvent)
      .where(
        and(eq(schema.auditEvent.resourceType, "evidence"), eq(schema.auditEvent.resourceId, id)),
      ),
  );

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
        name: "Ada Lovelace",
        email: `${slug}@example.test`,
        password: "correct horse",
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const userId = (await json<{ user: { id: string } }>(signedUp)).user.id;
    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: slug, slug }),
    });
    expect(created.status).toBe(200);
    return { cookie, userId, organizationId: (await json<{ id: string }>(created)).id };
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
    alter table "evidence" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);

  const newControl = async (owner: Tenant, name: string) => {
    const response = await request(owner, "/controls", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(201);
    return (await json<{ data: { id: string } }>(response)).data.id;
  };
  control = await newControl(acme, "Access review");
  theirControl = await newControl(globex, "Globex only");
}, 60_000);

describe("recording evidence", () => {
  it("records it against the control, unattested", async () => {
    const evidence = await record(acme, control, { title: "Recorded" });

    expect(evidence.id).toMatch(/^evd_[0-9a-z]{16}$/);
    expect(evidence.attestation).toBeNull();
    expect(evidence.occurredAt).toBe("2026-07-01T09:00:00.000Z");
  });

  it("is readable by its own identifier", async () => {
    const evidence = await record(acme, control, { title: "Findable" });

    const response = await request(acme, `/evidence/${evidence.id}`);

    expect(response.status).toBe(200);
    expect((await json<{ data: Evidence }>(response)).data.title).toBe("Findable");
  });

  it.each([
    ["no collected date", { occurredAt: undefined }],
    ["a collected date that is not a date", { occurredAt: "last Tuesday" }],
    ["no title", { title: undefined }],
  ])("refuses evidence with %s", async (_case, body) => {
    const response = await request(acme, `/controls/${control}/evidence`, {
      method: "POST",
      body: JSON.stringify({ title: "T", occurredAt: "2026-07-01T09:00:00.000Z", ...body }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("answers 404 for another organization's control", async () => {
    const response = await request(acme, `/controls/${theirControl}/evidence`, {
      method: "POST",
      body: JSON.stringify({ title: "Smuggled", occurredAt: "2026-07-01T09:00:00.000Z" }),
    });

    expect(response.status).toBe(404);
  });

  it("lists a control's evidence, most recently occurred first", async () => {
    const own = await request(acme, "/controls", {
      method: "POST",
      body: JSON.stringify({ name: "Listed" }),
    });
    const listed = (await json<{ data: { id: string } }>(own)).data.id;
    for (const day of ["2026-01-01", "2026-03-01", "2026-02-01"]) {
      await record(acme, listed, { title: day, occurredAt: `${day}T00:00:00.000Z` });
    }

    const { data } = await json<Page<Evidence>>(
      await request(acme, `/controls/${listed}/evidence?limit=100`),
    );

    // By when the thing happened, not when it was typed in.
    expect(data.map((row) => row.title)).toEqual(["2026-03-01", "2026-02-01", "2026-01-01"]);
  });
});

describe("amending evidence", () => {
  it("changes a draft", async () => {
    const evidence = await record(acme, control, { title: "Before" });

    const response = await amend(acme, evidence.id, { title: "After" });

    expect(response.status).toBe(200);
    expect((await json<{ data: Evidence }>(response)).data.title).toBe("After");
  });

  it("records what changed", async () => {
    const evidence = await record(acme, control, { title: "Audited" });

    await amend(acme, evidence.id, { title: "Audited again" });

    const history = await historyOf(acme, evidence.id);
    expect(history.map((event) => event.action)).toEqual(["created", "updated"]);
    expect(history.at(-1)).toMatchObject({
      before: { title: "Audited" },
      after: { title: "Audited again" },
    });
  });

  it("refuses a body asking for no change", async () => {
    const evidence = await record(acme, control, { title: "Unchanged" });

    expect((await amend(acme, evidence.id, {})).status).toBe(400);
  });
});

describe("attesting", () => {
  it("records who vouched, and when", async () => {
    const evidence = await record(acme, control, { title: "Vouched for" });

    const response = await attest(acme, evidence.id);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: Evidence }>(response);
    expect(data.attestation?.by).toEqual({ id: acme.userId, label: "Ada Lovelace" });
    expect(Date.parse(data.attestation!.at)).toBeGreaterThan(0);
  });

  it("is one act, not a repeatable one", async () => {
    const evidence = await record(acme, control, { title: "Once" });
    expect((await attest(acme, evidence.id)).status).toBe(200);

    const again = await attest(acme, evidence.id);

    expect(again.status).toBe(409);
    expect((await json<Failure>(again)).error.code).toBe("already_attested");
  });

  it("refuses to change attested evidence", async () => {
    const evidence = await record(acme, control, { title: "Settled" });
    await attest(acme, evidence.id);

    const response = await amend(acme, evidence.id, { title: "Rewritten" });

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("already_attested");
    const { data } = await json<{ data: Evidence }>(
      await request(acme, `/evidence/${evidence.id}`),
    );
    expect(data.title).toBe("Settled");
  });

  it("refuses to attest while impersonating", async () => {
    // An administrator acting as a member may do that member's work. Vouching
    // is a signature, and signing as somebody else is forgery however it is
    // logged.
    const evidence = await record(acme, control, { title: "Not yours to sign" });
    const administrator = await signUp("administrator@example.test");
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = ${administrator}
            where "user_id" = ${acme.userId}`,
      ),
    );

    const response = await attest(acme, evidence.id);

    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = null where "user_id" = ${acme.userId}`,
      ),
    );
    expect(response.status).toBe(403);
    expect((await json<Failure>(response)).error.code).toBe("impersonated");
    const { data } = await json<{ data: Evidence }>(
      await request(acme, `/evidence/${evidence.id}`),
    );
    expect(data.attestation).toBeNull();
  });

  it("refuses to sign without saying what was read", async () => {
    const evidence = await record(acme, control, { title: "Unread" });

    const response = await request(acme, `/evidence/${evidence.id}/attestation`, { method: "PUT" });

    expect(response.status).toBe(428);
    expect((await json<Failure>(response)).error.code).toBe("precondition_required");
  });

  it("refuses to sign content that changed since it was read", async () => {
    // Alice reads the draft, Bob amends it, Alice signs. Without the
    // precondition she would have endorsed what Bob wrote.
    const evidence = await record(acme, control, { title: "As Alice read it" });
    const tag = (await request(acme, `/evidence/${evidence.id}`)).headers.get("etag")!;
    await amend(acme, evidence.id, { title: "As Bob left it" });

    const response = await attest(acme, evidence.id, tag);

    expect(response.status).toBe(412);
    expect((await json<Failure>(response)).error.code).toBe("precondition_failed");
    const { data } = await json<{ data: Evidence }>(
      await request(acme, `/evidence/${evidence.id}`),
    );
    expect(data.attestation).toBeNull();
  });

  it("offers the tag an attestation has to quote", async () => {
    const evidence = await record(acme, control, { title: "Tagged" });

    const response = await request(acme, `/evidence/${evidence.id}`);

    expect(response.headers.get("etag")).toMatch(/^"\d+"$/);
  });

  it("records the attestation in history", async () => {
    const evidence = await record(acme, control, { title: "Historied" });

    await attest(acme, evidence.id);

    const history = await historyOf(acme, evidence.id);
    expect(history.map((event) => event.action)).toEqual(["created", "attested"]);
  });
});

describe("dates this API will not take", () => {
  it("refuses evidence of something that has not happened", async () => {
    const response = await request(acme, `/controls/${control}/evidence`, {
      method: "POST",
      body: JSON.stringify({
        title: "Next year's review",
        occurredAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it.each([
    ["year zero", "0000-01-01T00:00:00.000Z"],
    ["a year that grows past four digits once the offset is applied", "9999-12-31T23:59:59-01:00"],
    ["a year that shrinks below one", "0001-01-01T00:00:00+01:00"],
  ])("refuses %s", async (_case, occurredAt) => {
    // Each of these parses. Year zero is one PostgreSQL has not got; the other
    // two leave the four digits this API deals in, and `toISOString` writes
    // them in the expanded `+010000` form. Without the bound each is a 500
    // rather than a bad request.
    const response = await request(acme, `/controls/${control}/evidence`, {
      method: "POST",
      body: JSON.stringify({ title: "Out of range", occurredAt }),
    });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("keeps an offset date as the instant it names", async () => {
    const evidence = await record(acme, control, {
      title: "Offset",
      occurredAt: "2026-07-01T10:00:00+01:00",
    });

    expect(evidence.occurredAt).toBe("2026-07-01T09:00:00.000Z");
  });
});

describe("what the database itself refuses", () => {
  /** Attested evidence, and a draft beside it, both of this organization. */
  const pair = async () => {
    const attested = await record(acme, control, { title: "Attested" });
    await attest(acme, attested.id);
    const draft = await record(acme, control, { title: "Draft" });
    return { attested: attested.id, draft: draft.id };
  };

  it("will not update an attested row, whatever the application asks", async () => {
    // Round the routes entirely. The policy's USING clause sees only
    // unattested rows, so an attested one is not there to update (VERSION-01).
    const { attested } = await pair();

    const updated = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.evidence)
        .set({ title: "Rewritten behind the API" })
        .where(eq(schema.evidence.id, attested))
        .returning(),
    );

    expect(updated).toEqual([]);
  });

  it("will not delete an attested row", async () => {
    const { attested } = await pair();

    const deleted = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.evidence).where(eq(schema.evidence.id, attested)).returning(),
    );

    expect(deleted).toEqual([]);
  });

  it("still allows a draft to be changed and discarded", async () => {
    // The finality is about attested rows, not about the table.
    const { draft } = await pair();

    const updated = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.evidence)
        .set({ title: "Still a draft" })
        .where(eq(schema.evidence.id, draft))
        .returning(),
    );
    const deleted = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.evidence).where(eq(schema.evidence.id, draft)).returning(),
    );

    expect(updated).toHaveLength(1);
    expect(deleted).toHaveLength(1);
  });

  it.each([
    ["a time with nobody behind it", { attestedAt: new Date() }],
    ["an empty attester", { attestedAt: new Date(), attestedById: "  " }],
    ["a name with no time", { attestedByLabel: "Ada Lovelace" }],
  ])("will not store %s", async (_case, values) => {
    // Half an attestation is not an attestation, and the third would make the
    // row final while still reading as unattested.
    const draft = await record(acme, control, { title: "Halfway" });

    const attempt = withOrganization(db, acme.organizationId, (tx) =>
      tx.update(schema.evidence).set(values).where(eq(schema.evidence.id, draft.id)),
    );

    await expect(attempt).rejects.toThrow();
  });
});

describe("evidence and tenants", () => {
  it("hides another organization's evidence", async () => {
    const theirs = await record(globex, theirControl, { title: "Globex only" });

    const retrieved = await request(acme, `/evidence/${theirs.id}`);
    const absent = await request(acme, "/evidence/evd_0000000000000000");

    expect(retrieved.status).toBe(404);
    expect(await json(retrieved)).toEqual(await json(absent));
  });

  it.each([
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "ctl_v1stgxr8z5jdhi6b"],
  ])("answers 404 for %s", async (_case, id) => {
    expect((await request(acme, `/evidence/${id}`)).status).toBe(404);
  });
});

describe("discarding evidence", () => {
  it("removes an unattested record, which nothing could do before", async () => {
    // The DELETE policy has admitted unattested rows since evidence arrived
    // (ADR 0012); until now no route asked. Without this a draft control that
    // ever had evidence recorded against it could not be discarded either.
    const evidence = await record(acme, control, { title: "Thought better of it" });

    const response = await discard(acme, evidence.id);

    expect(response.status).toBe(204);
    expect((await request(acme, `/evidence/${evidence.id}`)).status).toBe(404);
  });

  it("refuses attested evidence, and says what to do instead", async () => {
    const evidence = await record(acme, control, { title: "Signed" });
    expect((await attest(acme, evidence.id)).status).toBe(200);

    const response = await discard(acme, evidence.id);

    expect(response.status).toBe(409);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("already_attested");
    expect(error.details?.[0]?.message).toContain("record a correction instead");
    expect((await request(acme, `/evidence/${evidence.id}`)).status).toBe(200);
  });

  it("will not let the database remove an attested one either", async () => {
    const evidence = await record(acme, control, { title: "Final" });
    expect((await attest(acme, evidence.id)).status).toBe(200);

    const removed = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.evidence).where(eq(schema.evidence.id, evidence.id)).returning(),
    );

    expect(removed).toEqual([]);
  });

  it("takes the attached files with it, and says which in the history", async () => {
    // `file` cascades from evidence, so the rows go. The bytes stay on the
    // volume — a foreign key cannot reach a filesystem (ADR 0013) — so the
    // event names what was attached, which is the only record left of it.
    const evidence = await record(acme, control, { title: "With an attachment" });
    const before = (await leaves(directory)).length;
    const uploaded = await request(acme, `/evidence/${evidence.id}/files?filename=minutes.txt`, {
      method: "POST",
      body: "the minutes",
    });
    expect(uploaded.status).toBe(201);
    const fileId = (await json<{ data: { id: string } }>(uploaded)).data.id;

    expect((await discard(acme, evidence.id)).status).toBe(204);

    expect((await request(acme, `/files/${fileId}`)).status).toBe(404);
    const rows = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.file).where(eq(schema.file.id, fileId)),
    );
    expect(rows).toEqual([]);
    // The bytes outlive the row: a foreign key cannot reach a filesystem, and
    // nothing sweeps the volume (ADR 0013). That is why the event names them.
    expect(await leaves(directory)).toHaveLength(before + 1);
    const deletion = (await historyOf(acme, evidence.id)).find(
      (event) => event.action === "deleted",
    );
    // Which control it belonged to survives the row.
    expect(deletion?.before).toMatchObject({ controlId: control, files: ["minutes.txt"] });
    expect(deletion?.after).toBeNull();
  });

  it("lets the control it belonged to be discarded afterwards", async () => {
    // The point of the whole thing: ADR 0017 tells a caller to remove the
    // evidence first, and this is that being possible.
    const ours = await json<{ data: { id: string } }>(
      await app.request(`/api/v1/organizations/${acme.organizationId}/controls`, {
        method: "POST",
        headers: { cookie: acme.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Abandoned with evidence" }),
      }),
    );
    const evidence = await record(acme, ours.data.id, { title: "Recorded by mistake" });

    const blocked = await request(acme, `/controls/${ours.data.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect((await json<Failure>(blocked)).error.code).toBe("has_evidence");

    expect((await discard(acme, evidence.id)).status).toBe(204);
    const now = await request(acme, `/controls/${ours.data.id}`, { method: "DELETE" });

    expect(now.status).toBe(204);
  });

  it("answers 404 for an id of the wrong shape, without asking the database", async () => {
    // A NUL cannot go into a `text` column, so an id carrying one reaches
    // PostgreSQL as a 500 unless it is refused on the way in.
    const malformed = await discard(acme, "not-an-id");
    const nul = await discard(acme, encodeURIComponent("evd_v1stgxr8z5jdhi6\u0000"));

    expect(malformed.status).toBe(404);
    expect((await json<Failure>(malformed)).error.message).toBe("No such evidence.");
    expect(nul.status).toBe(404);
  });

  it("answers 404 for another organization's evidence, and leaves it alone", async () => {
    const theirs = await record(globex, theirControl, { title: "Theirs" });

    const response = await discard(acme, theirs.id);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.message).toBe("No such evidence.");
    expect((await request(globex, `/evidence/${theirs.id}`)).status).toBe(200);
  });
});

describe("amending and discarding only what you read", () => {
  const tagOf = async (id: string) => {
    const response = await request(acme, `/evidence/${id}`);
    expect(response.status).toBe(200);
    return response.headers.get("etag")!;
  };

  it("refuses an amendment against a version that has moved", async () => {
    const evidence = await record(acme, control, { title: "Contested" });
    const read = await tagOf(evidence.id);
    expect((await amend(acme, evidence.id, { title: "First wins" })).status).toBe(200);

    const late = await request(acme, `/evidence/${evidence.id}`, {
      method: "PATCH",
      headers: { "if-match": read, "content-type": "application/json" },
      body: JSON.stringify({ title: "Second, unaware" }),
    });

    expect(late.status).toBe(412);
    expect((await json<Failure>(late)).error.code).toBe("precondition_failed");
    const { data } = await json<{ data: { title: string } }>(
      await request(acme, `/evidence/${evidence.id}`),
    );
    expect(data.title).toBe("First wins");
  });

  it("answers an amendment with the new tag", async () => {
    const evidence = await record(acme, control, { title: "Chained" });

    const response = await request(acme, `/evidence/${evidence.id}`, {
      method: "PATCH",
      headers: { "if-match": await tagOf(evidence.id), "content-type": "application/json" },
      body: JSON.stringify({ title: "Amended" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(await tagOf(evidence.id));
  });

  it("refuses a discard against a version that has moved", async () => {
    const evidence = await record(acme, control, { title: "About to go" });
    const read = await tagOf(evidence.id);
    expect((await amend(acme, evidence.id, { title: "Changed underneath" })).status).toBe(200);

    const stale = await request(acme, `/evidence/${evidence.id}`, {
      method: "DELETE",
      headers: { "if-match": read },
    });

    expect(stale.status).toBe(412);
    expect((await request(acme, `/evidence/${evidence.id}`)).status).toBe(200);
  });

  it("discards against the version just read", async () => {
    // The other half of the refusal above: a correct tag must still work, or
    // the route could refuse every conditional request and look right.
    const evidence = await record(acme, control, { title: "Agreed to go" });

    const gone = await request(acme, `/evidence/${evidence.id}`, {
      method: "DELETE",
      headers: { "if-match": await tagOf(evidence.id) },
    });

    expect(gone.status).toBe(204);
  });

  it("says attested rather than stale when both are true", async () => {
    // The row is read unlocked first precisely so this answers 409: locking
    // first would find nothing, because an attested row cannot be locked, and
    // "cannot be locked" would come back as "does not exist".
    const evidence = await record(acme, control, { title: "Signed and stale" });
    const read = await tagOf(evidence.id);
    expect((await attest(acme, evidence.id)).status).toBe(200);

    const refused = await request(acme, `/evidence/${evidence.id}`, {
      method: "DELETE",
      headers: { "if-match": read },
    });

    expect(refused.status).toBe(409);
    expect((await json<Failure>(refused)).error.code).toBe("already_attested");
  });

  it("moves the version when a file is attached", async () => {
    // Files are part of how evidence reads back, so attaching one changes the
    // record. If the tag did not move, a caller could discard evidence whose
    // attachments it never saw — and the files would cascade away with it.
    const evidence = await record(acme, control, { title: "Gaining a file" });
    const read = await tagOf(evidence.id);

    const uploaded = await request(acme, `/evidence/${evidence.id}/files?filename=late.txt`, {
      method: "POST",
      body: "arrived after the read",
    });
    expect(uploaded.status).toBe(201);

    expect(await tagOf(evidence.id)).not.toBe(read);
    const stale = await request(acme, `/evidence/${evidence.id}`, {
      method: "DELETE",
      headers: { "if-match": read },
    });
    expect(stale.status).toBe(412);
    expect((await request(acme, `/evidence/${evidence.id}`)).status).toBe(200);
  });

  it("still requires If-Match to attest, which is not the same thing", async () => {
    // Optional for an amendment, required for a signature: attesting means
    // attesting something in particular (ADR 0012).
    const evidence = await record(acme, control, { title: "Signed" });

    const without = await request(acme, `/evidence/${evidence.id}/attestation`, {
      method: "PUT",
    });

    expect(without.status).toBe(428);
    expect((await json<Failure>(without)).error.code).toBe("precondition_required");
  });
});

describe("the evidence of the controls mapped to a requirement", () => {
  /** A standard of three clauses, and controls mapped to the first two. */
  let clause: string[];
  let backups: string;
  let access: string;

  const newControl = async (name: string) => {
    const response = await request(acme, "/controls", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return (await json<{ data: { id: string } }>(response)).data.id;
  };

  const mapTo = (controlId: string, requirementIds: string[]) =>
    request(acme, `/controls/${controlId}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds }),
    });

  const evidenceOf = async (requirementId: string, query = "?limit=100") => {
    const response = await request(acme, `/requirements/${requirementId}/evidence${query}`);
    expect(response.status).toBe(200);
    return json<Page<Evidence & { controlId: string; files: { filename: string }[] }>>(response);
  };

  beforeAll(async () => {
    const imported = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 27001",
        edition: "2022",
        requirements: ["A.8.13", "A.5.15", "A.5.16"].map((reference) => ({
          reference,
          title: reference,
        })),
      }),
    });
    expect(imported.status).toBe(201);
    const standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const listed = await json<Page<{ id: string }>>(
      await request(acme, `/standards/${standardId}/requirements`),
    );
    clause = listed.data.map((row) => row.id);

    backups = await newControl("Backups");
    access = await newControl("Access review");
    expect((await mapTo(backups, [clause[0]!])).status).toBe(200);
    expect((await mapTo(access, [clause[0]!, clause[1]!])).status).toBe(200);

    await record(acme, backups, { title: "Restore test", occurredAt: "2026-02-01T00:00:00.000Z" });
    await record(acme, access, { title: "Q1 review", occurredAt: "2026-03-01T00:00:00.000Z" });
    await record(acme, access, { title: "Q4 review", occurredAt: "2025-12-01T00:00:00.000Z" });
  });

  it("gathers it across controls, most recently occurred first", async () => {
    const { data, nextCursor } = await evidenceOf(clause[0]!);

    expect(data.map((row) => [row.title, row.controlId])).toEqual([
      ["Q1 review", access],
      ["Restore test", backups],
      ["Q4 review", access],
    ]);
    expect(nextCursor).toBeNull();
  });

  it("keeps to the controls mapped to that requirement", async () => {
    const { data } = await evidenceOf(clause[1]!);

    expect(data.map((row) => row.title)).toEqual(["Q1 review", "Q4 review"]);
  });

  it("is an empty page for a requirement no control answers to", async () => {
    const { data, nextCursor } = await evidenceOf(clause[2]!);

    expect(data).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it("pages without repeating or losing a row", async () => {
    const first = await evidenceOf(clause[0]!, "?limit=2");
    const second = await evidenceOf(
      clause[0]!,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );

    expect([...first.data, ...second.data].map((row) => row.title)).toEqual([
      "Q1 review",
      "Restore test",
      "Q4 review",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor from the control's own evidence", async () => {
    const { nextCursor } = await json<Page<Evidence>>(
      await request(acme, `/controls/${access}/evidence?limit=1`),
    );

    const response = await request(
      acme,
      `/requirements/${clause[1]!}/evidence?cursor=${encodeURIComponent(nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it("carries attestations and attached files, as the control's own list does", async () => {
    const control = await newControl("Attested");
    const evidence = await record(acme, control, {
      title: "Signed",
      occurredAt: "2026-04-01T00:00:00.000Z",
    });
    const uploaded = await request(acme, `/evidence/${evidence.id}/files?filename=signed.txt`, {
      method: "POST",
      body: "signed minutes",
    });
    expect(uploaded.status).toBe(201);
    expect((await attest(acme, evidence.id)).status).toBe(200);
    // Mapped after it was attested: an attestation endorses the evidence, not
    // the mapping, so it is listed all the same.
    expect((await mapTo(control, [clause[2]!])).status).toBe(200);

    const { data } = await evidenceOf(clause[2]!);

    expect(data).toHaveLength(1);
    expect(data[0]!.attestation?.by.id).toBe(acme.userId);
    expect(data[0]!.files.map((file) => file.filename)).toEqual(["signed.txt"]);
  });

  it("includes a retired control's evidence, and drops an unmapped one's", async () => {
    const control = await newControl("Retiring");
    await record(acme, control, { title: "Last run", occurredAt: "2026-05-01T00:00:00.000Z" });
    expect((await mapTo(control, [clause[1]!])).status).toBe(200);
    for (const status of ["active", "retired"]) {
      const response = await request(acme, `/controls/${control}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(200);
    }

    expect((await evidenceOf(clause[1]!)).data.map((row) => row.title)).toContain("Last run");

    expect((await mapTo(control, [])).status).toBe(200);
    expect((await evidenceOf(clause[1]!)).data.map((row) => row.title)).not.toContain("Last run");
    // Out of the view, not gone.
    const own = await json<Page<Evidence>>(await request(acme, `/controls/${control}/evidence`));
    expect(own.data.map((row) => row.title)).toEqual(["Last run"]);
  });

  it("answers 404 for another organization's requirement, as for one that does not exist", async () => {
    const theirs = await request(globex, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 27001",
        edition: "2022",
        requirements: [{ reference: "A.8.13", title: "Backup" }],
      }),
    });
    const theirStandard = (await json<{ data: { id: string } }>(theirs)).data.id;
    const theirClause = (
      await json<Page<{ id: string }>>(
        await request(globex, `/standards/${theirStandard}/requirements`),
      )
    ).data[0]!.id;
    await record(globex, theirControl, { title: "Theirs" });
    const mapped = await request(globex, `/controls/${theirControl}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds: [theirClause] }),
    });
    expect(mapped.status).toBe(200);

    const response = await request(acme, `/requirements/${theirClause}/evidence`);
    const absent = await request(acme, "/requirements/req_0000000000000000/evidence");

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual(await json(absent));
  });

  it("breaks a tie between controls by identifier, and pages across it", async () => {
    const imported = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Tied",
        edition: "1",
        requirements: [{ reference: "1", title: "One" }],
      }),
    });
    const standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const requirement = (
      await json<Page<{ id: string }>>(await request(acme, `/standards/${standardId}/requirements`))
    ).data[0]!.id;
    const same = { occurredAt: "2026-06-01T00:00:00.000Z" };
    const ids: string[] = [];
    for (const name of ["Left", "Right"]) {
      const control = await newControl(name);
      expect((await mapTo(control, [requirement])).status).toBe(200);
      ids.push((await record(acme, control, { title: name, ...same })).id);
    }

    const first = await evidenceOf(requirement, "?limit=1");
    const second = await evidenceOf(
      requirement,
      `?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );

    // Newest first, so the larger identifier leads when the dates tie.
    expect([...first.data, ...second.data].map((row) => row.id)).toEqual(ids.sort().reverse());
    expect(second.nextCursor).toBeNull();
  });

  it("answers 404 for an id of the wrong shape, without asking the database", async () => {
    const response = await request(acme, `/requirements/${backups}/evidence`);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
  });
});
