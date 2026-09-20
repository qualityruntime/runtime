// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the sweep removes, and — mostly — what it refuses to.
 *
 * This is the only thing in the product that deletes evidence bytes, so the
 * cases worth the most here are the ones where it must do nothing: a file that
 * still has a row, an object written a minute ago, a key belonging to whatever
 * else shares the bucket, and a database that is not this deployment's
 * (ADR 0021).
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createId, schema, withOrganization } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { fileKey, uploadKey } from "./objects.ts";
import { describeReclamation, gracePeriod, reclaimStorage } from "./reclaim.ts";
import { attachFile, inMemoryObjectStore, prepareUpload, sendBytes } from "./s3-in-memory.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;
let storage: ReturnType<typeof inMemoryObjectStore>;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;
let control: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

const asTenant = (tenant: Tenant) => (path: string, init?: Request) => request(tenant, path, init);

/** Long enough ago that the sweep will look at it. */
const longAgo = () => new Date(Date.now() - gracePeriod - 60_000);

/** Ages an object, as waiting a day would. */
/** Pushes an upload's window back, so it closed `ago` milliseconds since. */
const expire = (uploadId: string, ago: number) =>
  withOrganization(db, acme.organizationId, (tx) =>
    tx
      .update(schema.fileUpload)
      .set({ expiresAt: new Date(Date.now() - ago) })
      .where(eq(schema.fileUpload.id, uploadId)),
  );

const age = (key: string) => {
  const object = storage.objects.get(key)!;
  storage.objects.set(key, { ...object, writtenAt: longAgo() });
};

async function newEvidence(tenant: Tenant, controlId: string): Promise<string> {
  const response = await request(tenant, `/controls/${controlId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

/** Evidence of Acme's carrying one file. Answers both identifiers. */
async function attached(contents = "the minutes") {
  const evidenceId = await newEvidence(acme, control);
  const response = await attachFile(storage, asTenant(acme), evidenceId, contents);
  expect(response.status).toBe(200);
  return { evidenceId, fileId: (await json<{ data: { id: string } }>(response)).data.id };
}

/** An upload prepared and sent, never completed. Answers its identifier. */
async function abandoned(tenant = acme) {
  const evidenceId = await newEvidence(tenant, control);
  return sendBytes(storage, await prepareUpload(asTenant(tenant), evidenceId), "never completed");
}

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  storage = inMemoryObjectStore();
  app = createApp({
    db,
    store: storage.store,
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

  const response = await request(acme, "/controls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Access review" }),
  });
  expect(response.status).toBe(201);
  control = (await json<{ data: { id: string } }>(response)).data.id;

  // Everything below runs as a role that owns nothing and bypasses nothing.
  // PGlite connects as a superuser, and PostgreSQL exempts a superuser from
  // every policy — so a sweep written against one reads every organization's
  // files inside each organization's context, and a version of it that read
  // only the first tenant would pass this file with the rest of them deleted.
  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    alter table "standard" owner to qualityruntime_app;
    alter table "requirement" owner to qualityruntime_app;
    alter table "control_requirement" owner to qualityruntime_app;
    alter table "evidence" owner to qualityruntime_app;
    alter table "file" owner to qualityruntime_app;
    alter table "file_upload" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

describe("what it leaves alone", () => {
  it("keeps every file a row still claims", async () => {
    const { fileId } = await attached();
    age(fileKey(fileId));

    const { orphans } = await reclaimStorage(db, storage.store, { remove: true });

    expect(orphans.map((orphan) => orphan.key)).not.toContain(fileKey(fileId));
    expect(storage.objects.has(fileKey(fileId))).toBe(true);
  });

  it("keeps an object written too recently to judge", async () => {
    // The window between promoting an object and committing the row naming it
    // has no transaction across it. A sweep that ran inside that window and
    // took the object would leave a row pointing at bytes that are gone, which
    // is the one outcome nothing can repair (ADR 0021).
    const { evidenceId, fileId } = await attached("promoted a moment ago");
    // Its row is gone, so nothing claims the bytes — and they are still kept,
    // because the sweep will not judge an object this new.
    expect((await request(acme, `/evidence/${evidenceId}`, { method: "DELETE" })).status).toBe(204);

    const { orphans, recent } = await reclaimStorage(db, storage.store, { remove: true });

    expect(orphans.map((orphan) => orphan.key)).not.toContain(fileKey(fileId));
    expect(recent).toBeGreaterThan(0);
    expect(storage.objects.has(fileKey(fileId))).toBe(true);
  });

  it("keeps an upload whose window is still open", async () => {
    const uploadId = await abandoned();
    age(uploadKey(uploadId));

    const { orphans } = await reclaimStorage(db, storage.store, { remove: true });

    // Prepared minutes ago and still completable: the bytes are the client's
    // to finish sending, whatever their age.
    expect(orphans.map((orphan) => orphan.key)).not.toContain(uploadKey(uploadId));
    expect(storage.objects.has(uploadKey(uploadId))).toBe(true);
  });

  it("keeps whatever else shares the bucket", async () => {
    // A bucket may hold other things. Nothing this product did not name is
    // this product's to remove, however unclaimed it looks.
    const strangers = ["files/not-an-identifier", "uploads/nested/fil_v1stgxr8z5jdhi6b", "files/"];
    for (const key of strangers) {
      storage.objects.set(key, {
        bytes: new TextEncoder().encode("somebody else's"),
        contentType: "application/octet-stream",
        writtenAt: longAgo(),
      });
    }

    const { foreign } = await reclaimStorage(db, storage.store, { remove: true });

    expect(foreign).toBeGreaterThanOrEqual(strangers.length);
    for (const key of strangers) expect(storage.objects.has(key)).toBe(true);
  });

  it("removes nothing at all unless it is asked to", async () => {
    const uploadId = await abandoned();
    await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.fileUpload)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.fileUpload.id, uploadId)),
    );
    age(uploadKey(uploadId));

    const reported = await reclaimStorage(db, storage.store);

    expect(reported.orphans.map((orphan) => orphan.key)).toContain(uploadKey(uploadId));
    expect(reported.removed).toBe(0);
    expect(reported.intents).toBe(0);
    expect(storage.objects.has(uploadKey(uploadId))).toBe(true);
  });
});

describe("what it reclaims", () => {
  it("takes the bytes of a file whose row went with its evidence", async () => {
    // Discarding evidence takes its `file` rows by cascade, and a foreign key
    // cannot reach a bucket. This is the only thing that closes that.
    const { evidenceId, fileId } = await attached("about to be orphaned");
    expect((await request(acme, `/evidence/${evidenceId}`, { method: "DELETE" })).status).toBe(204);
    age(fileKey(fileId));

    const { orphans, removed } = await reclaimStorage(db, storage.store, { remove: true });

    expect(orphans.find((orphan) => orphan.key === fileKey(fileId))?.kind).toBe("file");
    expect(removed).toBeGreaterThan(0);
    expect(storage.objects.has(fileKey(fileId))).toBe(false);
  });

  it("takes an abandoned upload's bytes and its record together", async () => {
    const uploadId = await abandoned();
    await expire(uploadId, gracePeriod + 1000);
    age(uploadKey(uploadId));

    const { intents } = await reclaimStorage(db, storage.store, { remove: true });

    expect(intents).toBeGreaterThan(0);
    expect(storage.objects.has(uploadKey(uploadId))).toBe(false);
    const left = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.fileUpload).where(eq(schema.fileUpload.id, uploadId)),
    );
    expect(left).toEqual([]);
  });

  it("keeps a record that only just expired, so a late completion is told why", async () => {
    // The policy would let this go the moment the window closed. Keeping it
    // for as long as its bytes are kept is what turns a late completion's
    // answer from "no such upload" into "the window has closed" — the
    // completion is refused either way.
    const uploadId = await abandoned();
    await expire(uploadId, 1000);
    age(uploadKey(uploadId));

    const { intents } = await reclaimStorage(db, storage.store, { remove: true });

    expect(intents).toBe(0);
    const left = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.fileUpload).where(eq(schema.fileUpload.id, uploadId)),
    );
    expect(left).toHaveLength(1);
  });

  it("keeps the record of an upload that produced a file", async () => {
    // That row is what makes completing an upload idempotent: remove it and a
    // client retrying a lost response attaches a second file.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await sendBytes(
      storage,
      await prepareUpload(asTenant(acme), evidenceId),
      "completed",
    );
    expect(
      (await request(acme, `/file-uploads/${uploadId}/completion`, { method: "PUT" })).status,
    ).toBe(200);
    await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.fileUpload)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.fileUpload.id, uploadId)),
    );

    await reclaimStorage(db, storage.store, { remove: true });

    const kept = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.fileUpload).where(eq(schema.fileUpload.id, uploadId)),
    );
    expect(kept).toHaveLength(1);
  });

  it("looks in every organization, inside each one's own context", async () => {
    // A sweep that read only the tenant it happened to start in would call
    // every other tenant's files unclaimed and delete them.
    const theirControl = await request(globex, "/controls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Supplier audit" }),
    });
    const theirEvidence = await newEvidence(
      globex,
      (await json<{ data: { id: string } }>(theirControl)).data.id,
    );
    const theirs = await attachFile(storage, asTenant(globex), theirEvidence, "theirs");
    const theirFile = (await json<{ data: { id: string } }>(theirs)).data.id;
    const { fileId } = await attached();
    age(fileKey(theirFile));
    age(fileKey(fileId));

    const { orphans } = await reclaimStorage(db, storage.store, { remove: true });

    expect(orphans).toEqual([]);
    expect(storage.objects.has(fileKey(theirFile))).toBe(true);
    expect(storage.objects.has(fileKey(fileId))).toBe(true);
  });

  it("follows the listing past its first page", async () => {
    // The store pages its listing. A sweep that stopped at the first page
    // would call the rest of the bucket unclaimed — or, worse, miss the
    // orphans it exists to find.
    const orphaned: string[] = [];
    for (let which = 0; which < 5; which += 1) {
      const key = fileKey(createId("file"));
      storage.objects.set(key, {
        bytes: new TextEncoder().encode(`orphan ${which}`),
        contentType: "application/octet-stream",
        writtenAt: longAgo(),
      });
      orphaned.push(key);
    }

    const { orphans } = await reclaimStorage(db, storage.store, { remove: true });

    expect(orphans.map((orphan) => orphan.key)).toEqual(expect.arrayContaining(orphaned));
    for (const key of orphaned) expect(storage.objects.has(key)).toBe(false);
  });
});

describe("a database that is not this deployment's", () => {
  it("refuses to reclaim anything when no file is recorded at all", async () => {
    // A replica that never caught up, or a restore that never loaded, makes
    // every object in the bucket look unclaimed. Removing them would be
    // irreversible, and the alternative — saying so and stopping — costs an
    // operator a second look.
    const empty = createTestDatabase(new PGlite());
    await migrate(empty, { migrationsFolder });
    const key = fileKey(createId("file"));
    storage.objects.set(key, {
      bytes: new TextEncoder().encode("still somebody's"),
      contentType: "application/octet-stream",
      writtenAt: longAgo(),
    });

    const reclamation = await reclaimStorage(empty, storage.store, { remove: true });

    expect(reclamation.removed).toBe(0);
    expect(reclamation.refused).toContain("DATABASE_URL");
    expect(storage.objects.has(key)).toBe(true);
    expect(describeReclamation(reclamation)).toContain("removed none");
  }, 60_000);
});

describe("what it tells a person", () => {
  it("says so plainly when there is nothing to do", () => {
    const report = describeReclamation({
      orphans: [],
      removed: 0,
      removedBytes: 0,
      failed: [],
      intents: 0,
      recent: 0,
      foreign: 0,
    });

    expect(report).toContain("Nothing in the bucket is unclaimed");
  });

  it("says what it left alone, and why", () => {
    const report = describeReclamation({
      orphans: [],
      removed: 0,
      removedBytes: 0,
      failed: [],
      intents: 0,
      recent: 3,
      foreign: 2,
    });

    expect(report).toContain("3 written too recently");
    expect(report).toContain("2 under keys this product did not issue");
  });

  it("names what the store would not let go of, and what it already removed", () => {
    // A sweep that abandoned its report at the first refusal would leave an
    // operator with a stack trace and no record of what had gone. The two
    // objects are both orphans, as they must be: one went, one did not.
    const report = describeReclamation({
      orphans: [
        { key: "files/fil_v1stgxr8z5jdhi6b", bytes: 11, writtenAt: new Date(), kind: "file" },
        { key: "files/fil_hu5wkjet02hl611j", bytes: 9_000, writtenAt: new Date(), kind: "file" },
      ],
      removed: 1,
      removedBytes: 11,
      failed: [{ key: "files/fil_hu5wkjet02hl611j", detail: "DELETE failed: 403 Forbidden." }],
      intents: 0,
      recent: 0,
      foreign: 0,
    });

    // The space reclaimed is the space reclaimed, not the space found: a
    // report that added the object the store refused would name 9011 bytes
    // nobody got back.
    expect(report).toContain("9011 bytes in all");
    expect(report).toContain("Removed 1 of them, 11 bytes.");
    expect(report).toContain("1 could not be removed");
    expect(report).toContain("403 Forbidden");
  });

  it("does not tell an operator whose every removal failed to try the same flag", () => {
    const report = describeReclamation({
      orphans: [
        { key: "files/fil_v1stgxr8z5jdhi6b", bytes: 11, writtenAt: new Date(), kind: "file" },
      ],
      removed: 0,
      removedBytes: 0,
      failed: [{ key: "files/fil_v1stgxr8z5jdhi6b", detail: "DELETE failed: 403 Forbidden." }],
      intents: 0,
      recent: 0,
      foreign: 0,
    });

    expect(report).toContain("Nothing could be removed");
    expect(report).not.toContain("--remove");
  });

  it("says how to act on what it found", () => {
    const report = describeReclamation({
      orphans: [
        { key: "files/fil_v1stgxr8z5jdhi6b", bytes: 11, writtenAt: new Date(), kind: "file" },
      ],
      removed: 0,
      removedBytes: 0,
      failed: [],
      intents: 0,
      recent: 0,
      foreign: 0,
    });

    expect(report).toContain("files/fil_v1stgxr8z5jdhi6b");
    expect(report).toContain("--remove");
  });
});
