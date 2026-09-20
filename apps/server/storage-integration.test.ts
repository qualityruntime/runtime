// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The object store, against a real one.
 *
 * `objects.test.ts` runs the same implementation against an S3 that answers in
 * memory, which proves this product's half of the conversation: what it signs,
 * what preconditions it sends, what it does with the answers. It cannot prove
 * the other half. A signature this product considers correct is only correct
 * if a real server agrees, `ListObjectsV2` has a shape nobody here decides,
 * and `x-amz-copy-source-if-match` is a promise a provider either keeps or
 * does not.
 *
 * So this is the same contract asked of something that is not ours. It is
 * skipped unless `TEST_STORAGE_ENDPOINT` names a store, in the same spirit as
 * `TEST_DATABASE_URL` — `bun run test` still needs nothing running, and CI
 * runs MinIO so that a change breaking a real store does not pass
 * (ADR 0020, ADR 0021).
 *
 * Unlike the concurrency suite's database, this wipes nothing: every key it
 * touches is one it just created under an identifier of its own, and it
 * removes them afterwards.
 */

import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createId } from "@qualityruntime/db";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { assertBucket, objectStoreInS3, type S3Configuration } from "./objects-in-s3.ts";
import { fileKey, measure, ObjectChanged, uploadKey } from "./objects.ts";

// The test runner does not read the repository's `.env`, and this suite is one
// of two that needs something out of it. Optional, as it is for drizzle-kit:
// no file and no variable simply means these tests do not run.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const endpoint = process.env.TEST_STORAGE_ENDPOINT;
const usable = Boolean(endpoint);

/**
 * Read one by one, and by name.
 *
 * `documented-setup.test.ts` finds every setting this repository reads by
 * looking for exactly this shape, and checks `.env.example` against what it
 * finds — so a setting reached through a variable would be one the example
 * could quietly stop mentioning.
 */
const settings = {
  bucket: process.env.TEST_STORAGE_BUCKET,
  region: process.env.TEST_STORAGE_REGION,
  accessKeyId: process.env.TEST_STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.TEST_STORAGE_SECRET_ACCESS_KEY,
};

/**
 * Missing settings throw rather than skip.
 *
 * Naming an endpoint and then leaving out the key pair is a mistake, and a
 * suite that answered it by quietly running nothing is the kind of green that
 * means less than it looks like.
 */
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set, though TEST_STORAGE_ENDPOINT is.`);
  return value;
}

let configuration: S3Configuration;
let store: ReturnType<typeof objectStoreInS3>;
/** Every key this suite wrote, so that it leaves the bucket as it found it. */
const written = new Set<string>();

/** A key of each kind, remembered for the clean-up below. */
const anUpload = () => {
  const key = uploadKey(createId("fileUpload"));
  written.add(key);
  return key;
};
const aFile = () => {
  const key = fileKey(createId("file"));
  written.add(key);
  return key;
};

const bytesOf = (text: string) => new TextEncoder().encode(text);
/** The checksum alone, where a test does not care how many bytes there were. */
const checksumIn = async (body: ReadableStream<Uint8Array>) => (await measure(body)).checksum;

const streamOfBytes = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytesOf(text));
      controller.close();
    },
  });

/** Uploads `contents` to `key` the way a client does: a signed PUT, and no more. */
async function upload(key: string, contents: string) {
  const signed = await store.signedUpload(key, { expiresIn: 300 });
  const sent = await fetch(signed.url, { method: signed.method, body: contents });
  expect(sent.status).toBe(200);
  await sent.body?.cancel();
}

beforeAll(() => {
  if (!usable) return;
  configuration = {
    bucket: required(settings.bucket, "TEST_STORAGE_BUCKET"),
    // The one with a sensible answer when it is left out: MinIO accepts any
    // region, and this is what a signature is computed against.
    region: settings.region ?? "us-east-1",
    accessKeyId: required(settings.accessKeyId, "TEST_STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required(settings.secretAccessKey, "TEST_STORAGE_SECRET_ACCESS_KEY"),
    endpoint,
  };
  store = objectStoreInS3(configuration);
});

afterAll(async () => {
  if (!usable) return;
  for (const key of written) await store.discard(key).catch(() => undefined);
});

describe.skipIf(!usable)("a real S3-compatible store", () => {
  it("is there, and says so before anything else runs", async () => {
    await expect(assertBucket(configuration)).resolves.toBeUndefined();
    await expect(assertBucket({ ...configuration, bucket: "not-a-bucket-here" })).rejects.toThrow();
  });

  it("accepts a signed upload, and reports what arrived", async () => {
    // The signature is the part nothing here can check for itself: a real
    // server recomputes it from its own canonicalization, and disagrees loudly.
    const key = anUpload();
    await upload(key, "the minutes");

    const seen = await store.inspect(key);

    expect(seen?.bytes).toBe("the minutes".length);
    expect(seen?.entityTag).toBeTruthy();
  });

  it("answers null for an object that is not there", async () => {
    // Providers differ on whether a missing object is a 404 or a 403 when the
    // credential cannot list the bucket. This is where that would show up.
    const key = anUpload();

    expect(await store.inspect(key)).toBeNull();
    expect(await store.read(key)).toBeNull();
  });

  it("keeps its word about the content it was asked for", async () => {
    const key = anUpload();
    await upload(key, "as measured");
    const seen = (await store.inspect(key))!;

    expect(await checksumIn((await store.read(key, { matching: seen.entityTag }))!)).toBe(
      await checksumIn(streamOf("as measured")),
    );

    // The same key, different bytes — which a signed PUT still allows until it
    // expires. `If-Match` is what makes that a refusal rather than a silently
    // different file.
    await upload(key, "something else entirely");
    await expect(store.read(key, { matching: seen.entityTag })).rejects.toBeInstanceOf(
      ObjectChanged,
    );
  });

  it("copies the content it was shown to a permanent key, and serves it as a download", async () => {
    const temporary = anUpload();
    await upload(temporary, "<script>alert(1)</script>");
    const seen = (await store.inspect(temporary))!;
    const permanent = aFile();

    await store.promote(temporary, permanent, {
      matching: seen.entityTag,
      filename: 'ev"il\r\n監査: 1.pdf',
    });

    // Read the way a client does: through a signed URL, with no credentials.
    const download = await fetch(await store.signedDownload(permanent, { expiresIn: 60 }));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    // A bearer URL whose response nothing forbids storing can outlive its own
    // minute in a cache. Only a real store proves the header survives the copy.
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    // Both spellings, returned as they were stored. A real store is where
    // this is worth asking: the header is metadata it holds and hands back,
    // and `filename*` is the half that is not plain ASCII.
    const disposition = download.headers.get("content-disposition")!;
    expect(disposition).toBe(
      `attachment; filename="ev_il____: 1.pdf"; ` +
        `filename*=UTF-8''ev%22il%0D%0A%E7%9B%A3%E6%9F%BB%3A%201.pdf`,
    );
    expect(await download.text()).toBe("<script>alert(1)</script>");
  });

  it("promotes stored bytes, whatever the client said they were encoded as", async () => {
    // The reason the checksum is measured from the permanent object and not
    // the staged one. A presigned PUT constrains the method and the key, not
    // the headers, so a client can store bytes as `gzip` — and `fetch` hands
    // an encoded response back decompressed. Only a real store settles this:
    // whether it keeps the encoding as metadata, returns it on a GET, and
    // whether the copy's metadata directive leaves it behind.
    const temporary = anUpload();
    const raw = "the minutes, at length ".repeat(50);
    const packed = gzipSync(Buffer.from(raw));
    const signed = await store.signedUpload(temporary, { expiresIn: 300 });
    const sent = await fetch(signed.url, {
      method: signed.method,
      headers: { "content-encoding": "gzip" },
      body: packed,
    });
    expect(sent.status).toBe(200);
    await sent.body?.cancel();

    const seen = (await store.inspect(temporary))!;
    const permanent = aFile();
    const copy = await store.promote(temporary, permanent, {
      matching: seen.entityTag,
      filename: "minutes.pdf",
    });

    // What the row would record, read exactly the way completion reads it:
    // pinned to the tag the copy itself reported. That composition is the
    // provider-dependent one — a tag spelled by `CopyObjectResult` and handed
    // straight back as `If-Match` on a `GET` — and it is what stops bytes
    // written between the two from becoming the baseline.
    // Asserted before it is used as a precondition: providers spell the tag in
    // `CopyObjectResult` differently from the one on a `HEAD` — AWS escapes the
    // quotes, MinIO's encoder writes `&#34;` — and a mismatch here says which
    // two strings disagree, where the conditional read below would only answer
    // 412.
    expect(copy.entityTag).toBe((await store.inspect(permanent))!.entityTag);
    const written = await measure((await store.read(permanent, { matching: copy.entityTag }))!);
    expect(written.bytes).toBe(packed.length);
    expect(written.checksum).toBe(await checksumIn(streamOfBytes(packed)));
    // Emphatically not the decompressed bytes. That is what hashing the staged
    // object would have recorded, for an object holding these.
    expect(written.checksum).not.toBe(await checksumIn(streamOf(raw)));
  });

  it("hands back the representation the store serves, encoding and all", async () => {
    // What `read` yields, exactly, against a store that is not ours. The
    // completion measures the permanent object, whose metadata this server
    // chose, so this does not describe that path — it pins down the property
    // the path depends on, and the one a privileged bucket writer could still
    // bend: an entity tag validates content, so an object's encoding can
    // change under a matching tag and `fetch` will decode accordingly.
    const key = anUpload();
    const raw = "the minutes, at length ".repeat(50);
    const packed = gzipSync(Buffer.from(raw));
    const signed = await store.signedUpload(key, { expiresIn: 300 });
    const sent = await fetch(signed.url, {
      method: signed.method,
      headers: { "content-encoding": "gzip" },
      body: packed,
    });
    expect(sent.status).toBe(200);
    await sent.body?.cancel();

    const seen = (await store.inspect(key))!;
    const read = await measure((await store.read(key, { matching: seen.entityTag }))!);

    // The store holds the compressed octets, and says so.
    expect(seen.bytes).toBe(packed.length);
    // And the read is decoded, which is why nothing durable is measured here.
    expect(read.bytes).toBe(raw.length);
  });

  it("refuses to copy content that is no longer there", async () => {
    // `x-amz-copy-source-if-match` is the promise the whole completion rests
    // on: that the object inspected and the object promoted are one object.
    const temporary = anUpload();
    await upload(temporary, "as measured");
    const seen = (await store.inspect(temporary))!;
    await upload(temporary, "changed underneath");
    const permanent = aFile();

    await expect(
      store.promote(temporary, permanent, { matching: seen.entityTag, filename: "minutes.pdf" }),
    ).rejects.toBeInstanceOf(ObjectChanged);
    expect(await store.inspect(permanent)).toBeNull();
  });

  it("will not let a URL signed for reading write anything", async () => {
    // Nothing should ever hand out a writable URL for a permanent key, and
    // this is the property that makes that worth relying on: the method is
    // signed, so a download URL is not a licence to replace the bytes.
    const temporary = anUpload();
    await upload(temporary, "the minutes");
    const seen = (await store.inspect(temporary))!;
    const permanent = aFile();
    await store.promote(temporary, permanent, {
      matching: seen.entityTag,
      filename: "minutes.pdf",
    });

    const readable = await store.signedDownload(permanent, { expiresIn: 60 });
    const tampering = await fetch(readable, { method: "PUT", body: "replaced" });
    await tampering.body?.cancel();

    expect(tampering.ok).toBe(false);
    expect(await checksumIn((await store.read(permanent))!)).toBe(
      await checksumIn(streamOf("the minutes")),
    );
  });

  it("lists what it holds under a prefix", async () => {
    // The shape of a `ListObjectsV2` answer is nobody's here to decide, and a
    // sweep that misread one would report a bucket as empty.
    const keys = [aFile(), aFile()];
    for (const key of keys) {
      const temporary = anUpload();
      await upload(temporary, `bytes for ${key}`);
      const seen = (await store.inspect(temporary))!;
      await store.promote(temporary, key, { matching: seen.entityTag, filename: "minutes.pdf" });
    }

    const found = [];
    for await (const object of store.list("files/")) found.push(object);

    for (const key of keys) {
      const object = found.find((each) => each.key === key);
      expect(object?.bytes).toBe(`bytes for ${key}`.length);
      expect(object?.writtenAt.getTime()).toBeGreaterThan(Date.now() - 60 * 60 * 1000);
    }
  });

  it("removes what it is asked to, and does not mind being asked twice", async () => {
    const key = anUpload();
    await upload(key, "briefly");

    await store.discard(key);
    await expect(store.discard(key)).resolves.toBeUndefined();

    expect(await store.inspect(key)).toBeNull();
  });
});
