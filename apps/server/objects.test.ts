// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The object store, against an S3 that answers in memory.
 *
 * What is worth proving here is the part of the design a client can reach: that
 * a signed URL works and stops working, that a permanent key is never one of
 * them, that the object sized is the object promoted, and that a filename
 * cannot become a response header of its own (ADR 0021).
 */

import { createId } from "@qualityruntime/db";
import { describe, expect, it, vi } from "vite-plus/test";
import { assertBucket, objectStoreInS3 } from "./objects-in-s3.ts";
import { fileKey, measure, ObjectChanged, uploadKey } from "./objects.ts";
import { inMemoryS3 } from "./s3-in-memory.ts";

/** A store, the S3 behind it, and a way to reach that S3 as a client would. */
function aStore() {
  const s3 = inMemoryS3();
  return { ...s3, store: objectStoreInS3(s3.configuration) };
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

/** A one-chunk stream, for hashing a known string. */
/** The checksum alone, where a test does not care how many bytes there were. */
const checksumIn = async (body: ReadableStream<Uint8Array>) => (await measure(body)).checksum;

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytesOf(text));
      controller.close();
    },
  });

/**
 * An upload identifier.
 *
 * `file_upload` and its `upl_` format arrive with the routes that need them;
 * the store cares only that a key names an identifier this product issued.
 */
const anUploadId = () => createId("file").replace(/^fil_/, "upl_");

describe("uploading", () => {
  it("takes bytes at a signed URL and reports what arrived", async () => {
    const { store, client } = aStore();
    const key = uploadKey(anUploadId());

    const signed = await store.signedUpload(key, { expiresIn: 300 });
    expect(signed.method).toBe("PUT");
    const upload = await client(signed.url, { method: "PUT", body: "minutes" });
    expect(upload.status).toBe(200);

    // The length the store reports, whatever the client declared.
    expect(await store.inspect(key)).toMatchObject({ bytes: 7 });
  });

  it("refuses a URL that has expired", async () => {
    const { store, client } = aStore();
    const key = uploadKey(anUploadId());
    const signed = await store.signedUpload(key, { expiresIn: 60 });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      const late = await client(signed.url, { method: "PUT", body: "minutes" });
      expect(late.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
    expect(await store.inspect(key)).toBeNull();
  });

  it("refuses a URL that was not signed", async () => {
    const { store, client } = aStore();
    const key = uploadKey(anUploadId());
    const signed = new URL((await store.signedUpload(key, { expiresIn: 300 })).url);

    signed.searchParams.set("X-Amz-Signature", "0".repeat(64));
    expect((await client(signed.toString(), { method: "PUT", body: "x" })).status).toBe(403);
    // Unsigned altogether, which is what a public bucket would allow.
    const bare = `${signed.origin}${signed.pathname}`;
    expect((await client(bare, { method: "PUT", body: "x" })).status).toBe(403);
  });

  it("will not touch a key this product did not issue", async () => {
    const { store } = aStore();
    await expect(store.inspect("../secrets")).rejects.toThrow("not a storage key");
    await expect(store.signedUpload("files/notanid", { expiresIn: 60 })).rejects.toThrow(
      "not a storage key",
    );
  });
});

describe("inspecting and reading", () => {
  it("answers for an object that is not there", async () => {
    const { store } = aStore();
    const key = uploadKey(anUploadId());

    expect(await store.inspect(key)).toBeNull();
    expect(await store.read(key)).toBeNull();
    // Asked for particular content, an absence is that content being gone.
    await expect(store.read(key, { matching: '"whatever"' })).rejects.toBeInstanceOf(ObjectChanged);
  });

  it("reads exactly the content that was inspected", async () => {
    const { store, client, objects } = aStore();
    const key = uploadKey(anUploadId());
    await client((await store.signedUpload(key, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });

    const seen = (await store.inspect(key))!;
    const bytes = await store.read(key, { matching: seen.entityTag });
    expect(await checksumIn(bytes!)).toBe(await checksumIn(streamOf("minutes")));

    // The upload URL stays usable until it expires, so the bytes can change
    // under a completion that has already sized them.
    objects.set(key, { bytes: bytesOf("something else"), contentType: "text/plain" });
    await expect(store.read(key, { matching: seen.entityTag })).rejects.toBeInstanceOf(
      ObjectChanged,
    );
  });
});

describe("a transfer that does not finish", () => {
  it("does not answer a checksum for bytes that stopped arriving", async () => {
    // A read can end early: the deadline every request carries, a dropped
    // connection, a store that gave up part-way. Hashing what arrived would
    // record a checksum for a file nobody has — and `verify:files` would then
    // report the real bytes as altered, for as long as the row exists.
    //
    // The deadline's own duration is not exercised here, only what happens
    // when a transfer ends without finishing, which is what it causes.
    const s3 = inMemoryS3();
    const store = objectStoreInS3({
      ...s3.configuration,
      fetch: (request) =>
        request.method === "GET"
          ? Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(bytesOf("the first half"));
                    controller.error(new Error("the connection went away"));
                  },
                }),
                { status: 200, headers: { etag: '"whatever"' } },
              ),
            )
          : s3.configuration.fetch!(request),
    });

    const bytes = await store.read(uploadKey(anUploadId()));

    await expect(measure(bytes!)).rejects.toThrow("went away");
  });
});

describe("addressing", () => {
  it("refuses a bucket name AWS cannot serve over HTTPS", () => {
    // A period makes the virtual-host name two labels deep, which the wildcard
    // certificate does not cover. An opaque TLS failure at start-up is a worse
    // way to learn this.
    expect(() =>
      objectStoreInS3({
        bucket: "quality.runtime",
        region: "eu-west-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
      }),
    ).toThrow(/period/);

    // Reachable through an endpoint, where the bucket is a path segment.
    expect(() =>
      objectStoreInS3({
        bucket: "quality.runtime",
        region: "eu-west-1",
        accessKeyId: "key",
        secretAccessKey: "secret",
        endpoint: "http://localhost:9000",
      }),
    ).not.toThrow();
  });

  it("touches only the two key shapes this product issues", async () => {
    const { store } = aStore();

    for (const key of [
      "files/fil_0000000000000000/../../etc",
      "uploads/upl_0000000000000000x",
      "files/evd_0000000000000000",
      "archive/fil_0000000000000000",
      "fil_0000000000000000",
    ]) {
      await expect(store.inspect(key)).rejects.toThrow(/is not a storage key/);
    }
    expect(await store.inspect("files/fil_0000000000000000")).toBeNull();
  });

  it("lists only the two prefixes this product keeps objects under", async () => {
    const { store } = aStore();

    // The type says so too. This is the other half: a bucket may be shared,
    // and a sweep acts on what a listing returns rather than on a key it was
    // given, so the one request that reaches past a known key is also checked.
    for (const prefix of ["", "/", "files", "archive/", "files/fil_0000000000000000"]) {
      const listing = store.list(prefix as never)[Symbol.asyncIterator]();
      await expect(listing.next()).rejects.toThrow(/is not a storage prefix/);
    }
  });
});

describe("promoting", () => {
  it("copies the inspected content to a permanent key, served as a download", async () => {
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      // What a client declared. Promotion replaces it.
      headers: { "content-type": "text/html" },
      body: "<script>alert(1)</script>",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    await store.promote(upload, file, { matching: seen.entityTag, filename: "minutes.html" });

    const promoted = objects.get(file)!;
    expect(promoted.contentType).toBe("application/octet-stream");
    expect(promoted.contentDisposition).toBe(
      `attachment; filename="minutes.html"; filename*=UTF-8''minutes.html`,
    );
    // The source survives promotion; removing it is the caller's to do.
    expect(objects.has(upload)).toBe(true);
  });

  it("refuses to promote an object that changed, and writes nothing", async () => {
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    objects.set(upload, { bytes: bytesOf("something else"), contentType: "text/plain" });

    await expect(
      store.promote(upload, file, { matching: seen.entityTag, filename: "minutes.pdf" }),
    ).rejects.toBeInstanceOf(ObjectChanged);
    expect(objects.has(file)).toBe(false);
  });

  it("refuses to promote an object that went away", async () => {
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    objects.delete(upload);

    await expect(
      store.promote(upload, file, { matching: seen.entityTag, filename: "minutes.pdf" }),
    ).rejects.toBeInstanceOf(ObjectChanged);
    expect(objects.has(file)).toBe(false);
  });

  it("does not believe a copy that failed after answering 200", async () => {
    // S3 answers a copy immediately and holds the connection while it works,
    // reporting a failure in the body. A promotion believed on its status
    // alone would leave a file row naming an object that was never written.
    const s3 = inMemoryS3();
    const answered = new Set<string>();
    const store = objectStoreInS3({
      ...s3.configuration,
      fetch: (request) => {
        if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) {
          answered.add(new URL(request.url).pathname);
          return Promise.resolve(
            new Response('<?xml version="1.0"?><Error><Code>InternalError</Code></Error>', {
              status: 200,
            }),
          );
        }
        return s3.configuration.fetch!(request);
      },
    });
    const upload = uploadKey(anUploadId());
    await s3.client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    await expect(
      store.promote(upload, file, { matching: seen.entityTag, filename: "minutes.pdf" }),
    ).rejects.toThrow("InternalError");
    expect(answered.size).toBe(1);
  });

  it("answers the tag of the object it created, and a cache policy with it", async () => {
    // The copy and the read that measures it are two operations. Pinning the
    // read to what the copy produced is what stops anything with write access
    // to the bucket slipping bytes in between them and becoming the baseline
    // the row records. The tag comes from the copy's own answer, so reading it
    // out is also the proof the copy finished.
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "the minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    const promoted = await store.promote(upload, file, {
      matching: seen.entityTag,
      filename: "minutes.pdf",
    });

    expect(promoted.entityTag).toBe((await store.inspect(file))!.entityTag);
    await expect(store.read(file, { matching: promoted.entityTag })).resolves.toBeTruthy();
    // A signed download is a bearer capability; a response nothing forbids
    // storing may be cached heuristically for as long as it likes.
    expect(objects.get(file)!.cacheControl).toBe("private, no-store");
  });

  it("keeps a name that is not ASCII, rather than mangling it", async () => {
    // The fallback is all a header may safely carry, and on its own it turns
    // every non-Latin name into underscores. `filename*` is the one clients
    // actually use, and this is the only moment it can be written: the header
    // is set on the object at promotion and a file cannot be repaired.
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "the minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    await store.promote(upload, file, { matching: seen.entityTag, filename: "監査証拠.pdf" });

    const disposition = objects.get(file)!.contentDisposition!;
    expect(disposition).toBe(
      `attachment; filename="____.pdf"; filename*=UTF-8''` +
        `%E7%9B%A3%E6%9F%BB%E8%A8%BC%E6%8B%A0.pdf`,
    );
  });

  it("will not let a filename write a header of its own", async () => {
    const { store, client, objects } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));

    await store.promote(upload, file, {
      matching: seen.entityTag,
      filename: 'ev"il\r\nContent-Type: text/html\r\n\r\n<script>.pdf',
    });

    const disposition = objects.get(file)!.contentDisposition!;
    expect(disposition).toContain('filename="ev_il__Content-Type: text/html____<script>.pdf"');
    // The other spelling carries the name intact, and the encoding is what
    // makes that safe: the carriage returns are three characters each here.
    expect(disposition).toContain(
      `filename*=UTF-8''ev%22il%0D%0AContent-Type%3A%20text%2Fhtml%0D%0A%0D%0A%3Cscript%3E.pdf`,
    );
    // No line break to end the header on, and the only quotes are the ones
    // this product put there.
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.match(/"/g)).toHaveLength(2);
  });
});

describe("listing", () => {
  /**
   * A response shaped as AWS S3 actually answers one, rather than as the
   * in-memory store writes it: a namespace, the elements around `<Contents>`,
   * an entity tag with escaped quotes, and a storage class. The parser reads
   * three fields out of that and ignores the rest, and this is what says so.
   */
  const page = (contents: string, next?: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
     <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
       <Name>evidence</Name><Prefix>files/</Prefix><KeyCount>2</KeyCount>
       <MaxKeys>1000</MaxKeys><IsTruncated>${next ? "true" : "false"}</IsTruncated>
       ${contents}
       ${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}
     </ListBucketResult>`;

  const entry = (key: string, size: number, modified: string) =>
    `<Contents>
       <Key>${key}</Key>
       <LastModified>${modified}</LastModified>
       <ETag>&quot;9b2cf5346f7c4dc6b4b1d1b7a4f00b1f&quot;</ETag>
       <Size>${size}</Size>
       <StorageClass>STANDARD</StorageClass>
     </Contents>`;

  /** A store whose listings are the pages given, in order. */
  const listing = (...pages: string[]) => {
    const asked: string[] = [];
    const s3 = inMemoryS3();
    const store = objectStoreInS3({
      ...s3.configuration,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get("list-type") !== "2") return s3.configuration.fetch!(request);
        asked.push(url.searchParams.get("continuation-token") ?? "");
        return Promise.resolve(new Response(pages[asked.length - 1]!, { status: 200 }));
      },
    });
    return { store, asked };
  };

  it("reads what a real listing says, and follows it to the end", async () => {
    const { store, asked } = listing(
      page(entry("files/fil_aaaaaaaaaaaaaaaa", 11, "2026-09-01T10:00:00.000Z"), "carry-on"),
      page(entry("files/fil_bbbbbbbbbbbbbbbb", 22, "2026-09-02T10:00:00.000Z")),
    );

    const seen = [];
    for await (const object of store.list("files/")) seen.push(object);

    expect(seen).toEqual([
      {
        key: "files/fil_aaaaaaaaaaaaaaaa",
        bytes: 11,
        writtenAt: new Date("2026-09-01T10:00:00.000Z"),
      },
      {
        key: "files/fil_bbbbbbbbbbbbbbbb",
        bytes: 22,
        writtenAt: new Date("2026-09-02T10:00:00.000Z"),
      },
    ]);
    // The second request carried the token the first answered with, and there
    // was no third: a listing that looped would never finish.
    expect(asked).toEqual(["", "carry-on"]);
  });

  it("refuses a truncated listing it cannot follow, rather than calling it the end", async () => {
    // Stopping here would report part of a bucket as all of it, and the one
    // caller that acts on a listing acts by deleting what it did not see
    // claimed. A loud failure is a report nobody acts on; a quiet one is a
    // sweep that removes live bytes.
    const { store } = listing(
      `<?xml version="1.0" encoding="UTF-8"?>
       <ListBucketResult><IsTruncated>true</IsTruncated>
         ${entry("files/fil_dddddddddddddddd", 11, "2026-09-01T10:00:00.000Z")}
       </ListBucketResult>`,
    );

    await expect(async () => {
      for await (const _ of store.list("files/"));
    }).rejects.toThrow(/truncated/);
  });

  it.each([
    ["is not a listing at all", "<Error><Code>SlowDown</Code></Error>"],
    [
      "will not say whether it is the whole of one",
      `<ListBucketResult><Contents></Contents></ListBucketResult>`,
    ],
  ])("refuses a 200 that %s", async (_case, page) => {
    // AWS documents a 200 carrying invalid XML. Read loosely, either of these
    // is a bucket reported as holding less than it does — and the one caller
    // that acts on a listing acts by deleting what it did not see claimed.
    const { store } = listing(page);

    await expect(async () => {
      for await (const _ of store.list("files/"));
    }).rejects.toThrow(/listing files\//);
  });

  it("answers nothing for a prefix holding nothing", async () => {
    const { store } = listing(page(""));

    const seen = [];
    for await (const object of store.list("uploads/")) seen.push(object);

    expect(seen).toEqual([]);
  });

  it("skips an entry it cannot read rather than inventing one", async () => {
    // A `Contents` without the three fields this needs is not something to
    // guess at — and a sweep acting on a guessed key is the worst outcome.
    const { store } = listing(
      page(
        `<Contents><Key>files/fil_cccccccccccccccc</Key></Contents>` +
          entry("files/fil_dddddddddddddddd", 5, "2026-09-03T10:00:00.000Z"),
      ),
    );

    const seen = [];
    for await (const object of store.list("files/")) seen.push(object);

    expect(seen.map((object) => object.key)).toEqual(["files/fil_dddddddddddddddd"]);
  });
});

describe("downloading", () => {
  it("hands out a readable URL that is never writable", async () => {
    const { store, client } = aStore();
    const upload = uploadKey(anUploadId());
    await client((await store.signedUpload(upload, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });
    const seen = (await store.inspect(upload))!;
    const file = fileKey(createId("file"));
    await store.promote(upload, file, { matching: seen.entityTag, filename: "minutes.pdf" });

    const url = await store.signedDownload(file, { expiresIn: 60 });
    const read = await client(url);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("minutes");
    expect(read.headers.get("content-disposition")).toBe(
      `attachment; filename="minutes.pdf"; filename*=UTF-8''minutes.pdf`,
    );

    // The same signature does not authorize a write: the method is signed.
    expect((await client(url, { method: "PUT", body: "tampered" })).status).toBe(403);
  });
});

describe("discarding", () => {
  it("removes bytes, and is content with bytes that are already gone", async () => {
    const { store, client, objects } = aStore();
    const key = uploadKey(anUploadId());
    await client((await store.signedUpload(key, { expiresIn: 300 })).url, {
      method: "PUT",
      body: "minutes",
    });

    await store.discard(key);
    expect(objects.has(key)).toBe(false);
    await expect(store.discard(key)).resolves.toBeUndefined();
  });
});

describe("the start-up check", () => {
  it("accepts a bucket that is there and refuses one that is not", async () => {
    const { configuration } = aStore();

    await expect(assertBucket(configuration)).resolves.toBeUndefined();
    await expect(assertBucket({ ...configuration, bucket: "elsewhere" })).rejects.toThrow(
      "STORAGE_BUCKET",
    );
  });
});
