// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Attaching bytes to evidence, and reading them back.
 *
 * A client's bytes never pass through the API: a client is authorized, uploads to
 * object storage directly, and then asks for what arrived to be attached. So
 * what is worth proving here is what the runtime decides — who may prepare an
 * upload, what the store is actually holding when the file row is written, and
 * that knowing a key is never permission to read it (DATA-01, ADR 0021).
 *
 * The store itself is exercised in `objects.test.ts`, against the same
 * implementation a deployment runs.
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
import { maxFileBytes, maxFilesPerEvidence } from "./files.ts";
import { objectStoreInS3 } from "./objects-in-s3.ts";
import { fileKey, measure, uploadKey } from "./objects.ts";
import {
  attachFile,
  completeUpload,
  inMemoryObjectStore,
  prepareUpload,
  sendBytes,
  uploadedBytes,
} from "./s3-in-memory.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));
const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let client: PGlite;
let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;
let storage: ReturnType<typeof inMemoryObjectStore>;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;
let control: string;
let theirEvidence: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type File = { id: string; filename: string; contentType: string; bytes: number; checksum: string };
type Upload = { id: string; expiresAt: string; upload: { method: string; url: string } };
type Failure = { error: { code: string } };
type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

/** The three steps, bound to a tenant. */
const asTenant = (tenant: Tenant) => (path: string, init?: Request) => request(tenant, path, init);

async function newEvidence(tenant: Tenant, controlId: string): Promise<string> {
  const response = await request(tenant, `/controls/${controlId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

/** An evidence record of Acme's, with a file on it. */
const attach = (evidenceId: string, contents = "the minutes", details = {}) =>
  attachFile(storage, asTenant(acme), evidenceId, contents, details);

/** A one-chunk stream, for hashing bytes the bucket holds. */
/** The checksum alone, where a test does not care how many bytes there were. */
const checksumIn = async (body: ReadableStream<Uint8Array>) => (await measure(body)).checksum;

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Every key of a kind the bucket is holding. */
const keys = (prefix: "files/" | "uploads/") =>
  [...storage.objects.keys()].filter((key) => key.startsWith(prefix));

beforeAll(async () => {
  client = new PGlite();
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

  const newControl = async (owner: Tenant) => {
    const response = await request(owner, "/controls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Access review" }),
    });
    expect(response.status).toBe(201);
    return (await json<{ data: { id: string } }>(response)).data.id;
  };
  control = await newControl(acme);
  theirEvidence = await newEvidence(globex, await newControl(globex));
}, 60_000);

describe("preparing an upload", () => {
  it("answers a URL the bytes can be sent to, and nothing about the bucket", async () => {
    const evidenceId = await newEvidence(acme, control);

    const response = await prepareUpload(asTenant(acme), evidenceId, { filename: "minutes.pdf" });

    expect(response.status).toBe(201);
    const { data } = await json<{ data: Upload }>(response);
    expect(data.id).toMatch(/^upl_/);
    expect(data.upload.method).toBe("PUT");
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());
    // The URL is a capability, not a description of the deployment: nothing in
    // the response names the bucket, the endpoint or the permanent key.
    expect(JSON.stringify(data)).not.toContain("files/");

    const sent = await storage.client(data.upload.url, { method: "PUT", body: "the minutes" });
    expect(sent.status).toBe(200);
  });

  it("refuses a file with no name", async () => {
    const evidenceId = await newEvidence(acme, control);

    const response = await prepareUpload(asTenant(acme), evidenceId, { filename: "   " });

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses a filename measured in characters but budgeted in bytes", async () => {
    // 255 characters of CJK is 765 bytes, and both spellings of the name go
    // into `Content-Disposition` at promotion — which AWS counts against a
    // 2 KiB metadata budget for the copy. Refused at the door, because the
    // alternative is failing after the bytes have been uploaded and copied.
    const evidenceId = await newEvidence(acme, control);

    const response = await prepareUpload(asTenant(acme), evidenceId, {
      filename: "監".repeat(255),
    });

    expect(response.status).toBe(400);
    // And the same name, within the budget, is fine.
    expect(
      (await prepareUpload(asTenant(acme), evidenceId, { filename: "監".repeat(85) })).status,
    ).toBe(201);
  });

  it("refuses a filename that is not well-formed Unicode", async () => {
    // A lone surrogate survives `JSON.parse`, and the percent-encoding at
    // promotion throws on one — a 500 at the end of a completion for
    // something a 400 can settle at the door.
    const evidenceId = await newEvidence(acme, control);

    const response = await prepareUpload(asTenant(acme), evidenceId, {
      filename: "minutes\ud800.pdf",
    });

    expect(response.status).toBe(400);
  });

  it("refuses a content type the database would refuse too", async () => {
    // It is written into the object's own headers at promotion and onto a row
    // that has no UPDATE policy, so a bad one cannot be repaired afterwards.
    const evidenceId = await newEvidence(acme, control);

    for (const contentType of [
      "application/pdf; charset=utf-8",
      "text/plain\r\nX-Evil: 1",
      "pdf",
    ]) {
      const response = await prepareUpload(asTenant(acme), evidenceId, { contentType });
      expect(response.status).toBe(400);
    }
  });

  it("refuses a size larger than a file may be, before issuing a URL", async () => {
    // The cheap refusal. A caller that declares nothing, or lies, meets the
    // same bound at completion against what the store ends up holding.
    const evidenceId = await newEvidence(acme, control);

    const before = keys("uploads/").length;
    const response = await prepareUpload(asTenant(acme), evidenceId, { bytes: maxFileBytes + 1 });

    expect(response.status).toBe(413);
    // No upload was recorded, so there is nothing to reclaim later either.
    expect(keys("uploads/")).toHaveLength(before);

    // And the limit itself is allowed: the bound is "larger than", and a file
    // of exactly the size the documentation names has to work.
    expect((await prepareUpload(asTenant(acme), evidenceId, { bytes: maxFileBytes })).status).toBe(
      201,
    );
  });

  it.each([
    ["evidence that is not there", "evd_0000000000000000"],
    ["an identifier of the wrong shape", "not-an-id"],
  ])("answers 404 for %s", async (_case, evidenceId) => {
    expect((await prepareUpload(asTenant(acme), evidenceId)).status).toBe(404);
  });

  it("answers 404 for another organization's evidence, indistinguishably", async () => {
    const response = await prepareUpload(asTenant(acme), theirEvidence);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
  });

  it("reserves nothing: the evidence can still be attested", async () => {
    // Preparing an upload is permission to attempt one. Evidence with an
    // upload outstanding is as final as any other, and it is the completion
    // that fails (ADR 0021).
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "too late");

    const tag = (await request(acme, `/evidence/${evidenceId}`)).headers.get("etag")!;
    const attested = await request(acme, `/evidence/${evidenceId}/attestation`, {
      method: "PUT",
      headers: { "if-match": tag },
    });
    expect(attested.status).toBe(200);

    const completed = await completeUpload(asTenant(acme), uploadId);
    expect(completed.status).toBe(409);
    expect((await json<Failure>(completed)).error.code).toBe("already_attested");
  });
});

describe("completing an upload", () => {
  it("records what the store holds, not what the client said", async () => {
    const evidenceId = await newEvidence(acme, control);

    // Declares one size and sends another. The declaration buys an early
    // refusal and is never persisted.
    const prepared = await prepareUpload(asTenant(acme), evidenceId, {
      filename: "minutes.pdf",
      contentType: "application/pdf",
      bytes: 1,
    });
    const uploadId = await sendBytes(storage, prepared, "the minutes");
    const response = await completeUpload(asTenant(acme), uploadId);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: File }>(response);
    expect(data.bytes).toBe("the minutes".length);
    expect(data.filename).toBe("minutes.pdf");
    expect(data.contentType).toBe("application/pdf");

    // The claim the whole integrity story rests on: what PostgreSQL recorded
    // is the hash of the bytes that are actually under the permanent key, not
    // of what was uploaded, declared, or intended. `verify:files` recomputes
    // this later and the two have to agree to mean anything (ADR 0021).
    const stored = storage.objects.get(fileKey(data.id))!;
    expect(data.checksum).toBe(await checksumIn(streamOf(stored.bytes)));
    expect(data.bytes).toBe(stored.bytes.byteLength);
  });

  it("records what the permanent object holds, not what the temporary one did", async () => {
    // The two can differ, and a client makes them differ: a PUT carrying
    // `Content-Encoding: gzip` is stored with that metadata and handed back
    // decompressed, while the copy moves the stored bytes without it. So the
    // read the row is built from must be of the object the row names — which
    // is what this substitutes under.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "what was staged");
    const kept = "what the bucket actually holds";
    const substituting = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (sent) =>
          sent.method === "GET" && sent.url.includes("/files/")
            ? new Response(kept, { status: 200 })
            : storage.configuration.fetch!(sent),
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await substituting.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(response.status).toBe(200);
    const { data } = await json<{ data: File }>(response);
    expect(data.checksum).toBe(await checksumIn(streamOf(new TextEncoder().encode(kept))));
    expect(data.bytes).toBe(kept.length);
  });

  it("moves the bytes to a permanent key and lets the temporary one go", async () => {
    const evidenceId = await newEvidence(acme, control);

    const before = keys("uploads/").length;
    const { data } = await json<{ data: File }>(await attach(evidenceId, "promoted"));

    expect(storage.objects.has(fileKey(data.id))).toBe(true);
    // The temporary copy is finished with, so the completion lets it go.
    expect(keys("uploads/")).toHaveLength(before);
  });

  it("lists what is attached with the evidence", async () => {
    const evidenceId = await newEvidence(acme, control);
    await attach(evidenceId, "the minutes", { filename: "notes.txt" });

    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );

    expect(data.files.map((file) => file.filename)).toEqual(["notes.txt"]);
  });

  it("refuses an upload nothing was sent to", async () => {
    const evidenceId = await newEvidence(acme, control);
    const prepared = await prepareUpload(asTenant(acme), evidenceId);
    const { data } = await json<{ data: Upload }>(prepared);

    const response = await completeUpload(asTenant(acme), data.id);

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("no_bytes");
  });

  it("refuses an empty object rather than letting a constraint answer", async () => {
    // `file_bytes_positive` would refuse it, and a CHECK violation would be a
    // 500 for what is a client mistake.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "");

    const response = await completeUpload(asTenant(acme), uploadId);

    expect(response.status).toBe(400);
    expect(storage.objects.has(uploadKey(uploadId))).toBe(false);
  });

  it("accepts a file of exactly the size a file may be", async () => {
    // The other side of the bound. Off by one here is the difference between
    // the limit `docs/deployment.md` names and the limit that actually holds.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(
      storage,
      asTenant(acme),
      evidenceId,
      new Uint8Array(maxFileBytes),
    );

    const response = await completeUpload(asTenant(acme), uploadId);

    expect(response.status).toBe(200);
    expect((await json<{ data: File }>(response)).data.bytes).toBe(maxFileBytes);
  }, 30_000);

  it("refuses an object larger than a file may be, and attaches nothing", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(
      storage,
      asTenant(acme),
      evidenceId,
      new Uint8Array(maxFileBytes + 1),
    );

    const response = await completeUpload(asTenant(acme), uploadId);

    expect(response.status).toBe(413);
    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );
    expect(data.files).toEqual([]);
    // Refused, and the bytes it refused let go.
    expect(storage.objects.has(uploadKey(uploadId))).toBe(false);
  }, 30_000);

  it("refuses bytes that changed after they were sized", async () => {
    // A signed URL stays usable until it expires, so the object can be
    // replaced between being measured and being promoted. Recording the
    // checksum of one file against the bytes of another is the thing this
    // cannot do, so the whole completion is refused instead.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "as measured");

    const meddling = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (asked) => {
          const answer = await storage.configuration.fetch!(asked);
          if (asked.method === "HEAD" && asked.url.includes("/uploads/")) {
            storage.objects.set(uploadKey(uploadId), {
              bytes: new TextEncoder().encode("something else entirely"),
              contentType: "application/octet-stream",
            });
          }
          return answer;
        },
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await meddling.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("upload_changed");
    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );
    expect(data.files).toEqual([]);
  });

  it("is safe to retry, and attaches one file however often it is asked", async () => {
    // The response a client lost is the response it gets back. Without this a
    // pipeline with a flaky network attaches the same report twice.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "sent once");

    const first = await completeUpload(asTenant(acme), uploadId);
    const again = await completeUpload(asTenant(acme), uploadId);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect((await json<{ data: File }>(again)).data).toEqual(
      (await json<{ data: File }>(first)).data,
    );
    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );
    expect(data.files).toHaveLength(1);
  });

  it("refuses an upload whose window has closed", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "too slow");
    await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.fileUpload)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.fileUpload.id, uploadId)),
    );

    const response = await completeUpload(asTenant(acme), uploadId);

    expect(response.status).toBe(410);
    expect((await json<Failure>(response)).error.code).toBe("upload_expired");
  });

  it("answers a retry with the same file long after the window closed", async () => {
    // The window bounds the right to complete, not the right to be told what a
    // completion produced. A client whose response was lost comes back the
    // next morning holding the upload id and must get the file, not a 410 and
    // a reason to upload it again — so the completed row is read before the
    // window is looked at.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "the minutes");
    const first = await json<{ data: File }>(await completeUpload(asTenant(acme), uploadId));
    // As the superuser: no policy admits this, because a completed upload is
    // not the runtime's to change. Which is the point — it stands in for a day
    // passing.
    await client.exec("reset role;");
    await client.query(`update "file_upload" set "expires_at" = $1 where "id" = $2`, [
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      uploadId,
    ]);
    await client.exec("set role qualityruntime_app;");

    const again = await completeUpload(asTenant(acme), uploadId);

    expect(again.status).toBe(200);
    expect((await json<{ data: File }>(again)).data.id).toBe(first.data.id);
  });

  it("refuses an upload whose window closes while its bytes are being checked", async () => {
    // The cheap refusal above happens before the store is touched. After it,
    // a 25 MiB read, hash and copy can outlast the window — so the deadline is
    // kept by `file_upload_tenant_complete` rather than by that check, and
    // this is what asks it to. The upload is expired mid-flight, from the
    // store's own `HEAD`.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "slow enough");
    const before = new Set(keys("files/"));
    const expiring = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (sent) => {
          if (sent.method === "HEAD") {
            await withOrganization(db, acme.organizationId, (tx) =>
              tx
                .update(schema.fileUpload)
                .set({ expiresAt: new Date(Date.now() - 1000) })
                .where(eq(schema.fileUpload.id, uploadId)),
            );
          }
          return storage.configuration.fetch!(sent);
        },
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await expiring.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(response.status).toBe(410);
    expect((await json<Failure>(response)).error.code).toBe("upload_expired");
    // Nothing attached, and nothing left behind: no retry of this upload will
    // be accepted, so neither key is anybody's.
    const attached = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.file).where(eq(schema.file.evidenceId, evidenceId)),
    );
    expect(attached).toEqual([]);
    expect(keys("files/").filter((key) => !before.has(key))).toEqual([]);
    expect(keys("uploads/")).not.toContain(uploadKey(uploadId));
  });

  it("refuses an upload whose window closes between the lock and the claim", async () => {
    // The lock is taken while the window is open; the statement that claims the
    // upload runs afterwards, judged against the clock as it is then. Left
    // unchecked it would match nothing, and this would answer 200 with a file
    // its upload does not claim.
    //
    // The trigger closes it at exactly that moment, which nothing else can
    // arrange reliably. `security definer` because no policy admits this: an
    // upload's window is not the runtime's to move.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "just too slow");
    const before = new Set(keys("files/"));
    await client.exec(`
      reset role;
      create function "close_the_window"() returns trigger language plpgsql security definer as $$
        begin
          update "file_upload" set "expires_at" = now() - interval '1 hour'
            where "file_id" is null and "evidence_id" = NEW."evidence_id";
          return NEW;
        end;
      $$;
      create trigger "close_the_window" before insert on "file"
        for each row execute function "close_the_window"();
      set role qualityruntime_app;
    `);
    let response: Response;
    try {
      response = await completeUpload(asTenant(acme), uploadId);
    } finally {
      await client.exec(`
        reset role;
        drop trigger "close_the_window" on "file";
        drop function "close_the_window"();
        set role qualityruntime_app;
      `);
    }

    expect(response.status).toBe(410);
    expect((await json<Failure>(response)).error.code).toBe("upload_expired");
    // The `file` row went back with the transaction, so neither key is
    // anybody's and both were cleaned up.
    const attached = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.file).where(eq(schema.file.evidenceId, evidenceId)),
    );
    expect(attached).toEqual([]);
    expect(keys("files/").filter((key) => !before.has(key))).toEqual([]);
    expect(keys("uploads/")).not.toContain(uploadKey(uploadId));
  });

  it("answers an attempt that lost a race with the file that won", async () => {
    // A client whose first request was slow retries while it is still
    // running. The winner removes the temporary object as it commits, so the
    // attempt still working finds nothing there — which is not "nothing was
    // uploaded", and answering 409 would break the idempotency the upload
    // identifier exists to provide.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "the minutes");
    let raced = false;
    const slow = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (sent) => {
          // Between this attempt reading its intent and looking at the store.
          if (!raced && sent.method === "HEAD") {
            raced = true;
            expect((await completeUpload(asTenant(acme), uploadId)).status).toBe(200);
          }
          return storage.configuration.fetch!(sent);
        },
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await slow.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(raced).toBe(true);
    expect(response.status).toBe(200);
    const [only] = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.file).where(eq(schema.file.evidenceId, evidenceId)),
    );
    expect((await json<{ data: File }>(response)).data.id).toBe(only!.id);
  });

  it("answers 410 when the window closes while the store is being checked", async () => {
    // The refusal this attempt is about to give is about the store; the reason
    // it will actually be refused is the deadline. Telling it "nothing was
    // uploaded" invites a retry the database has already decided against.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "just in time");
    let closed = false;
    const slow = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (sent) => {
          if (!closed && sent.method === "HEAD") {
            closed = true;
            await client.exec("reset role;");
            await client.query(`update "file_upload" set "expires_at" = $1 where "id" = $2`, [
              new Date(Date.now() - 1000),
              uploadId,
            ]);
            await client.exec("set role qualityruntime_app;");
            // And the staged object goes, so the refusal would have been
            // `no_bytes` were the window not the real answer.
            storage.objects.delete(uploadKey(uploadId));
          }
          return storage.configuration.fetch!(sent);
        },
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await slow.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(closed).toBe(true);
    expect(response.status).toBe(410);
    expect((await json<Failure>(response)).error.code).toBe("upload_expired");
  });

  it("answers 404 when the winner's evidence was discarded before this one looked", async () => {
    // The same recovery as above, one step further on: by the time this
    // attempt asks what became of its upload, there is no upload and no file.
    // "Nothing was uploaded" would be a refusal about the store for something
    // the database settled.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "briefly");
    let raced = false;
    const slow = createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: async (sent) => {
          if (!raced && sent.method === "HEAD") {
            raced = true;
            expect((await completeUpload(asTenant(acme), uploadId)).status).toBe(200);
            expect(
              (await request(acme, `/evidence/${evidenceId}`, { method: "DELETE" })).status,
            ).toBe(204);
          }
          return storage.configuration.fetch!(sent);
        },
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

    const response = await slow.request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

    expect(raced).toBe(true);
    expect(response.status).toBe(404);
  });

  it("keeps the promoted bytes when the transaction fails unexpectedly", async () => {
    // Nothing here tries to tell a rollback from a lost acknowledgement: a
    // driver error does not say whether the commit was made durable, and the
    // row may well be there, for evidence that may since have been attested.
    // So the bytes stay and `reclaim:storage` is what decides later, when the
    // rows can be read (ADR 0021). Raised by PostgreSQL rather than shaped by
    // hand, so it is a real error object taking the real path.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "unacknowledged");
    const before = new Set(keys("files/"));
    await client.exec(`
      reset role;
      create function "connection_lost"() returns trigger language plpgsql as $$
        begin raise exception 'connection lost' using errcode = '08006'; end;
      $$;
      create trigger "connection_lost" before insert on "file"
        for each row execute function "connection_lost"();
      set role qualityruntime_app;
    `);
    try {
      expect((await completeUpload(asTenant(acme), uploadId)).status).toBe(500);
    } finally {
      await client.exec(`
        reset role;
        drop trigger "connection_lost" on "file";
        drop function "connection_lost"();
        set role qualityruntime_app;
      `);
    }

    expect(keys("files/").filter((key) => !before.has(key))).toHaveLength(1);
  });

  it.each([
    ["an upload that is not there", "upl_0000000000000000"],
    ["an identifier of the wrong shape", "not-an-id"],
  ])("answers 404 for %s", async (_case, uploadId) => {
    expect((await completeUpload(asTenant(acme), uploadId)).status).toBe(404);
  });

  it("answers 404 when another organization tries to complete an upload", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "not theirs");

    const response = await completeUpload(asTenant(globex), uploadId);

    expect(response.status).toBe(404);
    // And it is still Acme's to complete.
    expect((await completeUpload(asTenant(acme), uploadId)).status).toBe(200);
  });

  it("answers 404 when the evidence was discarded while the bytes were in flight", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "orphaned");
    expect((await request(acme, `/evidence/${evidenceId}`, { method: "DELETE" })).status).toBe(204);

    const response = await completeUpload(asTenant(acme), uploadId);

    // The upload cascaded away with its evidence, so there is nothing to
    // complete — and nothing was promoted for it.
    expect(response.status).toBe(404);
  });
});

describe("a store that will not let go of anything", () => {
  /**
   * The same app, over a store whose every `DELETE` fails.
   *
   * Removing bytes is always tidying after a decision already made, so a store
   * that refuses must not change the decision: a 413 must not become a 500,
   * and a failed transaction's own account of itself must not be replaced by
   * the store's account of the clean-up. What is left behind is unreferenced
   * by construction, which is what `reclaim:storage` looks for (ADR 0021).
   */
  const unwilling = () =>
    createApp({
      db,
      store: objectStoreInS3({
        ...storage.configuration,
        fetch: (request) =>
          request.method === "DELETE"
            ? Promise.resolve(
                new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
              )
            : storage.configuration.fetch!(request),
      }),
      auth: createAuth(db, {
        baseURL: "http://localhost",
        secret: "test-secret-of-at-least-32-characters",
      }),
    });

  /** The completion, made against that app rather than the ordinary one. */
  const complete = (uploadId: string) =>
    unwilling().request(
      `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
      { method: "PUT", headers: { cookie: acme.cookie } },
    );

  it("still refuses an empty file with a 400", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "");

    expect((await complete(uploadId)).status).toBe(400);
  });

  it("still refuses an oversized file with a 413", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(
      storage,
      asTenant(acme),
      evidenceId,
      new Uint8Array(maxFileBytes + 1),
    );

    expect((await complete(uploadId)).status).toBe(413);
  }, 30_000);

  it("still attaches the file, and still answers with it", async () => {
    // The temporary object is left behind, and the file is no less attached
    // for it.
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "kept anyway");

    const response = await complete(uploadId);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: File }>(response);
    expect(storage.objects.has(fileKey(data.id))).toBe(true);
    // Left for the sweep, rather than turned into a failure.
    expect(storage.objects.has(uploadKey(uploadId))).toBe(true);
  });

  it("still refuses to attach to evidence that was attested meanwhile", async () => {
    const evidenceId = await newEvidence(acme, control);
    const uploadId = await uploadedBytes(storage, asTenant(acme), evidenceId, "too late");
    const tag = (await request(acme, `/evidence/${evidenceId}`)).headers.get("etag")!;
    expect(
      (
        await request(acme, `/evidence/${evidenceId}/attestation`, {
          method: "PUT",
          headers: { "if-match": tag },
        })
      ).status,
    ).toBe(200);

    const response = await complete(uploadId);

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("already_attested");
  });
});

describe("attested evidence keeps what it had", () => {
  const attested = async () => {
    const evidenceId = await newEvidence(acme, control);
    await attach(evidenceId, "before attesting");
    const tag = (await request(acme, `/evidence/${evidenceId}`)).headers.get("etag")!;
    const response = await request(acme, `/evidence/${evidenceId}/attestation`, {
      method: "PUT",
      headers: { "if-match": tag },
    });
    expect(response.status).toBe(200);
    return evidenceId;
  };

  it("refuses to prepare a new upload", async () => {
    const evidenceId = await attested();

    const response = await prepareUpload(asTenant(acme), evidenceId, { filename: "late.txt" });

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("already_attested");
  });

  it("will not let the database detach one either", async () => {
    // `file` has no DELETE policy: a record whose attachments can still change
    // is not final, and nothing detaches a file from any record (ADR 0013).
    const evidenceId = await attested();
    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );

    const deleted = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.file).where(eq(schema.file.id, data.files[0]!.id)).returning(),
    );

    expect(deleted).toEqual([]);
  });

  it("will not let the database attach one either", async () => {
    const evidenceId = await attested();

    const attempt = withOrganization(db, acme.organizationId, (tx) =>
      tx.insert(schema.file).values({
        organizationId: acme.organizationId,
        evidenceId,
        filename: "smuggled.txt",
        contentType: "text/plain",
        bytes: 1,
        checksum: "a".repeat(64),
      }),
    );

    await expect(attempt).rejects.toThrow();
  });
});

describe("reading a file back", () => {
  /** The file itself, by way of the redirect the API answers with. */
  const download = async (tenant: Tenant, fileId: string) => {
    const redirect = await request(tenant, `/files/${fileId}`);
    if (redirect.status !== 303) return { redirect, bytes: undefined };
    return { redirect, bytes: await storage.client(redirect.headers.get("location")!) };
  };

  it("redirects to the bytes rather than carrying them", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(await attach(evidenceId, "the minutes"));

    const { redirect, bytes } = await download(acme, data.id);

    expect(redirect.status).toBe(303);
    // Nothing to cache, and nothing to pass to the next origin: the URL
    // carries its own authorization for a minute.
    expect(redirect.headers.get("cache-control")).toBe("no-store");
    expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await bytes!.text()).toBe("the minutes");
  });

  it("never offers a file for the browser to render", async () => {
    // A tenant chooses the bytes and the content type; this origin does not
    // run them. Fixed into the object at promotion, so it holds however the
    // URL is reached (ADR 0021).
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(
      await attach(evidenceId, "<script>alert(1)</script>", {
        filename: "trouble.html",
        contentType: "text/html",
      }),
    );

    const { bytes } = await download(acme, data.id);

    expect(bytes!.headers.get("content-type")).toBe("application/octet-stream");
    expect(bytes!.headers.get("content-disposition")).toBe(
      `attachment; filename="trouble.html"; filename*=UTF-8''trouble.html`,
    );
    // The declared type survives as data, where it is harmless.
    expect(data.contentType).toBe("text/html");
  });

  it("puts nothing dangerous in a header", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(
      await attach(evidenceId, "harmless", { filename: 'ev"il\r\nX-Evil: 1.txt' }),
    );

    const { bytes } = await download(acme, data.id);

    const disposition = bytes!.headers.get("content-disposition")!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/"/g)).toHaveLength(2);
    // The real name survives on the row, where a header cannot be written.
    expect(data.filename).toBe('ev"il\r\nX-Evil: 1.txt');
  });

  it("refuses another organization's file, though the key would work", async () => {
    // Authorization is resolved in PostgreSQL before anything is signed, so
    // knowing an identifier buys nothing (DATA-01).
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(await attach(evidenceId, "ours"));

    const response = await request(globex, `/files/${data.id}`);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
    // The bytes are there all the same; what was refused was the permission.
    expect(storage.objects.has(fileKey(data.id))).toBe(true);
  });

  it.each([
    ["a file that is not there", "fil_0000000000000000"],
    ["an identifier of the wrong shape", "not-an-id"],
  ])("answers 404 for %s", async (_case, fileId) => {
    expect((await request(acme, `/files/${fileId}`)).status).toBe(404);
  });
});

describe("how many files evidence may carry", () => {
  it("stops at the limit rather than growing without bound", async () => {
    const evidenceId = await newEvidence(acme, control);
    for (let index = 0; index < maxFilesPerEvidence; index++) {
      const response = await attach(evidenceId, "x", { filename: `file${index}.txt` });
      expect(response.status).toBe(200);
    }

    const response = await attach(evidenceId, "x", { filename: "toomany.txt" });

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("too_many_files");
  }, 30_000);

  it("keeps no bytes for a file it refused", async () => {
    const evidenceId = await newEvidence(acme, control);
    for (let index = 0; index < maxFilesPerEvidence; index++) {
      await attach(evidenceId, "x", { filename: `file${index}.txt` });
    }
    const before = keys("files/").length;

    // Refused at the completion, after the object was already promoted — so
    // the promotion has to be undone, or every refusal leaves an orphan.
    await attach(evidenceId, "x", { filename: "toomany.txt" });

    expect(keys("files/")).toHaveLength(before);
  }, 30_000);
});
