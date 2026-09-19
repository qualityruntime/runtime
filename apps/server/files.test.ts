// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Files: the store on a volume, and attaching bytes to evidence.
 *
 * Two things are worth proving here. That the adapter does what the interface
 * promises — counts what it writes, refuses more than it was allowed, and
 * leaves nothing behind when it does. And that what may be read is decided in
 * PostgreSQL rather than by knowing a key (DATA-01).
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createId, schema, withOrganization } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { maxFilesPerEvidence } from "./files.ts";
import { assertVolume, fileStoreOnDisk } from "./storage-on-disk.ts";
import { TooManyBytes } from "./storage.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

const temporaryDirectory = () => mkdtemp(join(tmpdir(), "qualityruntime-"));
const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

/** A stream of `bytes` bytes, delivered in more than one chunk. */
const streamOf = (bytes: number, chunk = 1024) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      while (sent < bytes) {
        const size = Math.min(chunk, bytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x61));
        sent += size;
      }
      controller.close();
    },
  });

describe("a store on a volume", () => {
  it("counts and hashes what it writes, not what it was told", async () => {
    const store = fileStoreOnDisk(await temporaryDirectory());
    const key = createId("file");

    const stored = await store.put(key, streamOf(3000), 10_000);

    expect(stored.bytes).toBe(3000);
    // sha256 of 3000 'a's, so the hash is of the bytes rather than of a claim.
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    const read = await store.get(key);
    expect(read).not.toBeNull();
    const back = await new Response(read!).arrayBuffer();
    expect(back.byteLength).toBe(3000);
  });

  it("keeps writing when the filesystem takes less than it was given", async () => {
    // A short write is legal. Every write here takes at most 7 bytes, so a
    // store that trusted one call per chunk would keep a fraction of the file
    // under the size and checksum of all of it.
    const directory = await temporaryDirectory();
    const probe = await open(join(directory, "probe"), "w");
    const handles = Object.getPrototypeOf(probe) as {
      write: (buffer: Uint8Array, offset?: number, length?: number) => Promise<unknown>;
    };
    await probe.close();
    const write = handles.write;
    const short = vi.spyOn(handles, "write").mockImplementation(function (
      this: unknown,
      buffer,
      offset = 0,
      length,
    ) {
      const wanted = length ?? buffer.byteLength - offset;
      return write.call(this, buffer, offset, Math.min(7, wanted));
    });
    const store = fileStoreOnDisk(directory);
    const key = createId("file");

    try {
      await store.put(key, streamOf(3000), 10_000);
    } finally {
      short.mockRestore();
    }

    const back = new Uint8Array(await new Response((await store.get(key))!).arrayBuffer());
    expect(back.byteLength).toBe(3000);
    expect(back.every((byte) => byte === 0x61)).toBe(true);
  });

  it("refuses more bytes than it was allowed, and keeps none of them", async () => {
    const directory = await temporaryDirectory();
    const store = fileStoreOnDisk(directory);
    const key = createId("file");

    await expect(store.put(key, streamOf(5000), 4096)).rejects.toBeInstanceOf(TooManyBytes);

    // Not even the part that fitted: a half-written file is not a file.
    expect(await store.get(key)).toBeNull();
    expect(await leaves(directory)).toEqual([]);
  });

  it("has nothing under a key nothing was written to", async () => {
    const store = fileStoreOnDisk(await temporaryDirectory());

    expect(await store.get(createId("file"))).toBeNull();
  });

  it("forgets what it discards", async () => {
    const store = fileStoreOnDisk(await temporaryDirectory());
    const key = createId("file");
    await store.put(key, streamOf(10), 100);

    await store.discard(key);

    expect(await store.get(key)).toBeNull();
  });

  it("has nothing under a key holding something that is not a file", async () => {
    // Whatever can write to this volume can put a FIFO here, and opening one
    // blocks until a writer appears. A reader that waits forever is a worse
    // answer than "there are no bytes here" — and it would hang `verify:files`
    // without producing a report.
    const directory = await temporaryDirectory();
    const store = fileStoreOnDisk(directory);
    const key = createId("file");
    const random = key.slice(key.indexOf("_") + 1);
    const path = join(directory, random.slice(0, 2), random.slice(2, 4), key);
    await mkdir(dirname(path), { recursive: true });
    execFileSync("mkfifo", [path]);

    const bytes = await Promise.race([
      store.get(key),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
    ]);

    expect(bytes).toBeNull();
  });

  it("refuses a volume that is not there rather than calling every file missing", async () => {
    // An unmounted volume answers null for every key, which reads as the whole
    // deployment having been deleted. Cheaper to rule out once, at start-up.
    const directory = await temporaryDirectory();

    await expect(assertVolume(join(directory, "not-mounted"))).rejects.toThrow(/does not exist/);
    await expect(assertVolume(directory)).resolves.toBeUndefined();
  });

  it("discards a key it never held without complaining", async () => {
    const store = fileStoreOnDisk(await temporaryDirectory());

    await expect(store.discard(createId("file"))).resolves.toBeUndefined();
  });

  it.each([
    ["a path", "../../etc/passwd"],
    ["an absolute path", "/etc/passwd"],
    ["a key of the wrong shape", "not-a-key"],
    ["an empty key", ""],
  ])("will not treat %s as a key", async (_case, key) => {
    // Keys are identifiers PostgreSQL issued. Nothing else becomes a path.
    const store = fileStoreOnDisk(await temporaryDirectory());

    await expect(store.get(key)).rejects.toThrow(/storage key/);
  });

  it("spreads what it holds across directories", async () => {
    const directory = await temporaryDirectory();
    const store = fileStoreOnDisk(directory);
    const key = createId("file");

    await store.put(key, streamOf(10), 100);

    const [path] = await leaves(directory);
    // Two levels of fan-out, then the key itself.
    expect(path?.split("/")).toHaveLength(3);
    expect(path?.endsWith(key)).toBe(true);
  });
});

/** Every file under `directory`, as paths relative to it. */
async function leaves(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await leaves(directory, path)));
    else found.push(path);
  }
  return found;
}

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;
let directory: string;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;
let control: string;
let theirEvidence: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type File = { id: string; filename: string; bytes: number; checksum: string };
type Failure = { error: { code: string } };
/** `duplex` is required for a streamed body and missing from the DOM types. */
type Request = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  duplex?: "half";
};

const request = (tenant: Tenant, path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

async function newEvidence(tenant: Tenant, controlId: string): Promise<string> {
  const response = await request(tenant, `/controls/${controlId}/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

const upload = (tenant: Tenant, evidenceId: string, body: string, query = "filename=notes.txt") =>
  request(tenant, `/evidence/${evidenceId}/files?${query}`, { method: "POST", body });

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  directory = await temporaryDirectory();
  app = createApp({
    db,
    store: fileStoreOnDisk(directory),
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

describe("attaching a file", () => {
  it("stores the bytes and describes them", async () => {
    const evidenceId = await newEvidence(acme, control);

    const response = await upload(acme, evidenceId, "the minutes");

    expect(response.status).toBe(201);
    const { data } = await json<{ data: File }>(response);
    expect(data.id).toMatch(/^fil_[0-9a-z]{16}$/);
    expect(data.filename).toBe("notes.txt");
    expect(data.bytes).toBe("the minutes".length);
    expect(data.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lists what is attached with the evidence", async () => {
    const evidenceId = await newEvidence(acme, control);
    await upload(acme, evidenceId, "one");
    await upload(acme, evidenceId, "two", "filename=second.txt");

    const { data } = await json<{ data: { files: File[] } }>(
      await request(acme, `/evidence/${evidenceId}`),
    );

    expect(data.files.map((file) => file.filename)).toEqual(["notes.txt", "second.txt"]);
  });

  it("refuses a file with no name", async () => {
    const evidenceId = await newEvidence(acme, control);

    const response = await upload(acme, evidenceId, "bytes", "filename=");

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });

  it("refuses a file too large to accept", async () => {
    const evidenceId = await newEvidence(acme, control);

    const response = await request(acme, `/evidence/${evidenceId}/files?filename=big.bin`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(30 * 1024 * 1024) },
    });

    expect(response.status).toBe(413);
    expect((await json<Failure>(response)).error.code).toBe("payload_too_large");
  });

  it("refuses a body larger than it claimed to be", async () => {
    // The header is a claim. The bound is what the store counted, so a small
    // `Content-Length` with a large body is refused all the same.
    const evidenceId = await newEvidence(acme, control);
    const before = await leaves(directory);

    const response = await request(acme, `/evidence/${evidenceId}/files?filename=liar.bin`, {
      method: "POST",
      // Just past the limit, in chunks big enough that this is quick.
      body: streamOf(25 * 1024 * 1024 + 64 * 1024, 256 * 1024),
      headers: { "content-length": "10" },
      duplex: "half",
    });

    expect(response.status).toBe(413);
    expect((await json<Failure>(response)).error.code).toBe("payload_too_large");
    // Not even the part that fitted.
    expect(await leaves(directory)).toEqual(before);
  }, 30_000);

  it("keeps nothing when the body gives up part-way", async () => {
    const evidenceId = await newEvidence(acme, control);
    const before = await leaves(directory);
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024).fill(0x61));
        controller.error(new Error("the client went away"));
      },
    });

    const attempt = async () =>
      request(acme, `/evidence/${evidenceId}/files?filename=partial.bin`, {
        method: "POST",
        body: failing,
        duplex: "half",
      });

    // However it surfaces — a thrown request or a failed response — what
    // matters is that no half a file is left under a key.
    const outcome = await attempt().then(
      (response) => response.status,
      () => 500,
    );
    expect(outcome).toBeGreaterThanOrEqual(400);
    expect(await leaves(directory)).toEqual(before);
  });

  it.each([
    ["a header injection", "text/plain\r\nX-Injected: 1"],
    ["something that is not a media type", "not a media type"],
    ["a type with no subtype", "application"],
    ["a quoted parameter", 'text/plain; charset="utf-8"'],
  ])("refuses %s as a content type", async (_case, contentType) => {
    // Stored, this value would be written into a response header the file can
    // never be read without — and it could never be repaired, since `file` has
    // no UPDATE policy and an attested record keeps what it has.
    const evidenceId = await newEvidence(acme, control);

    const response = await upload(
      acme,
      evidenceId,
      "bytes",
      `filename=notes.txt&contentType=${encodeURIComponent(contentType)}`,
    );

    expect(response.status).toBe(400);
  });

  it("refuses a content type the database would refuse too", async () => {
    // The API is the courteous 400; the constraint is the guarantee.
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(await upload(acme, evidenceId, "bytes"));

    const error = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .insert(schema.file)
        .values({
          id: createId("file"),
          organizationId: acme.organizationId,
          evidenceId,
          filename: "notes.txt",
          contentType: "text/plain\r\nX-Injected: 1",
          bytes: 5,
          checksum: data.checksum,
        })
        .returning(),
    ).then(
      () => null,
      (thrown: Error) => thrown,
    );

    const reason = error?.cause instanceof Error ? error.cause.message : error?.message;
    expect(reason).toMatch(/file_content_type_shape/);
  });

  it("refuses an empty file rather than letting a constraint answer", async () => {
    // A `content-length: 0` has no body at all, but a chunked empty body
    // reaches `put` and stores nothing, which `file_bytes_positive` refuses.
    // An empty upload is a client mistake, not a server error.
    const evidenceId = await newEvidence(acme, control);
    const before = (await leaves(directory)).length;

    const response = await request(acme, `/evidence/${evidenceId}/files?filename=empty.txt`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    });

    expect(response.status).toBe(400);
    // Nothing was kept: an upload nobody accepted leaves no bytes behind.
    expect(await leaves(directory)).toHaveLength(before);
  });

  it("answers 404 for evidence that is not there", async () => {
    expect((await upload(acme, "evd_0000000000000000", "bytes")).status).toBe(404);
  });

  it("answers 404 for another organization's evidence, and stores nothing", async () => {
    const before = await leaves(directory);

    const response = await upload(acme, theirEvidence, "smuggled");

    expect(response.status).toBe(404);
    // The bytes are written before the row is attempted, so a refusal has to
    // take them away again.
    expect(await leaves(directory)).toEqual(before);
  });
});

describe("attested evidence keeps what it had", () => {
  const attested = async () => {
    const evidenceId = await newEvidence(acme, control);
    await upload(acme, evidenceId, "before attesting");
    const tag = (await request(acme, `/evidence/${evidenceId}`)).headers.get("etag")!;
    const response = await request(acme, `/evidence/${evidenceId}/attestation`, {
      method: "PUT",
      headers: { "if-match": tag },
    });
    expect(response.status).toBe(200);
    return evidenceId;
  };

  it("refuses a new file", async () => {
    const evidenceId = await attested();

    const response = await upload(acme, evidenceId, "afterwards", "filename=late.txt");

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
  it("returns the bytes that were stored", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(
      await upload(
        acme,
        evidenceId,
        "exactly these bytes",
        "filename=minutes.txt&contentType=text/plain",
      ),
    );

    const response = await request(acme, `/files/${data.id}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("exactly these bytes");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain('filename="minutes.txt"');
  });

  it("never offers a file for the browser to render", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(
      await upload(
        acme,
        evidenceId,
        "<script>alert(1)</script>",
        "filename=x.html&contentType=text/html",
      ),
    );

    const response = await request(acme, `/files/${data.id}`);

    // What a tenant uploaded is not this origin's to run.
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("puts nothing dangerous in a header", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(
      await upload(acme, evidenceId, "bytes", `filename=${encodeURIComponent('a"b\nc.txt')}`),
    );

    const response = await request(acme, `/files/${data.id}`);

    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).not.toContain("\n");
    expect(disposition.match(/"/g)).toHaveLength(2);
  });

  it("refuses another organization's file, though the key would work", async () => {
    // Knowing a key is not permission to read it: the row decides (DATA-01).
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(await upload(acme, evidenceId, "ours"));

    const theirs = await request(globex, `/files/${data.id}`);
    const absent = await request(globex, "/files/fil_0000000000000000");

    expect(theirs.status).toBe(404);
    expect(await json(theirs)).toEqual(await json(absent));
  });

  it.each([
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "evd_v1stgxr8z5jdhi6b"],
  ])("answers 404 for %s", async (_case, id) => {
    expect((await request(acme, `/files/${id}`)).status).toBe(404);
  });
});

describe("how many files evidence may carry", () => {
  it("stops at the limit rather than growing without bound", async () => {
    const evidenceId = await newEvidence(acme, control);
    for (let index = 0; index < maxFilesPerEvidence; index++) {
      expect((await upload(acme, evidenceId, "x", `filename=file${index}.txt`)).status).toBe(201);
    }

    const response = await upload(acme, evidenceId, "x", "filename=toomany.txt");

    expect(response.status).toBe(409);
    expect((await json<Failure>(response)).error.code).toBe("too_many_files");
  });

  it("keeps no bytes for a file it refused", async () => {
    const evidenceId = await newEvidence(acme, control);
    for (let index = 0; index < maxFilesPerEvidence; index++) {
      await upload(acme, evidenceId, "x", `filename=file${index}.txt`);
    }
    const before = await leaves(directory);

    await upload(acme, evidenceId, "x", "filename=toomany.txt");

    expect(await leaves(directory)).toEqual(before);
    // Twenty-one uploads, each synced to disk before it is acknowledged.
  }, 30_000);
});

describe("what the volume holds", () => {
  it("writes the file under the identifier the row carries", async () => {
    const evidenceId = await newEvidence(acme, control);
    const { data } = await json<{ data: File }>(await upload(acme, evidenceId, "findable"));

    const paths = await leaves(directory);

    expect(paths.some((path) => path.endsWith(data.id))).toBe(true);
    const random = data.id.slice(4);
    const stored = join(directory, random.slice(0, 2), random.slice(2, 4), data.id);
    expect((await stat(stored)).size).toBe("findable".length);
  });
});
