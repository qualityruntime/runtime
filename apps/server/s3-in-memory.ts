// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An S3-compatible store that answers in memory. For tests, and only for tests.
 *
 * `objects-in-s3.ts` is the one `ObjectStore` implementation this product has,
 * so the suite exercises it rather than a stand-in written to agree with it —
 * a second implementation would be a second thing to keep true, and the parts
 * most worth testing (signing, preconditions, the copy) live in the first one.
 * This is the other side of the wire: the subset of S3 that implementation
 * speaks, and the responses it has to get right.
 *
 * It verifies presigned signatures rather than waving them through, because
 * "the URL handed to a client actually works" is one of the things under test.
 * The helpers at the foot are the rest of the scaffolding: a store ready to
 * hand `createApp`, and the three requests attaching a file takes.
 */

import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import { objectStoreInS3, type S3Configuration } from "./objects-in-s3.ts";
import type { ObjectStore } from "./objects.ts";

type StoredBytes = {
  bytes: Uint8Array;
  contentType: string;
  contentDisposition?: string;
  cacheControl?: string;
  /** When this store last wrote it. Tests move it to age an object. */
  writtenAt?: Date;
};

export type InMemoryS3 = {
  /** Pass to `objectStoreInS3`. */
  configuration: S3Configuration;
  /** Every object, keyed as the store keys them. Tests read and corrupt this. */
  objects: Map<string, StoredBytes>;
  /** The store as a client reaches it, given a signed URL. */
  client: (url: string, init?: RequestInit) => Promise<Response>;
};

const region = "us-east-1";
const accessKeyId = "AKIAINMEMORY00000000";
const secretAccessKey = "0123456789abcdef0123456789abcdef01234567";

/** A validator that changes with the bytes, as an S3 entity tag does. */
const entityTagOf = (bytes: Uint8Array) =>
  `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;

const xml = (body: string, status: number) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

const error = (code: string, status: number) => xml(`<Error><Code>${code}</Code></Error>`, status);

/**
 * Whether a presigned URL is one this store issued, and is still good.
 *
 * Recomputed rather than trusted: a test that accepted any URL with a
 * `X-Amz-Signature` on it would pass against a store that signed nothing.
 */
async function presignedByUs(url: URL, method: string): Promise<boolean> {
  const given = url.searchParams.get("X-Amz-Signature");
  const datetime = url.searchParams.get("X-Amz-Date");
  const expiresIn = Number(url.searchParams.get("X-Amz-Expires"));
  if (!given || !datetime || !Number.isFinite(expiresIn)) return false;

  // `20260920T101500Z` — the only format the signer produces.
  const signedAt = Date.parse(
    datetime.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
  );
  if (!Number.isFinite(signedAt) || Date.now() > signedAt + expiresIn * 1000) return false;

  const unsigned = new URL(url);
  unsigned.searchParams.delete("X-Amz-Signature");
  const signer = new AwsV4Signer({
    url: unsigned.toString(),
    method,
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region,
    signQuery: true,
    datetime,
  });
  return (await signer.signature()) === given;
}

export function inMemoryS3(bucket = "evidence"): InMemoryS3 {
  const objects = new Map<string, StoredBytes>();
  const endpoint = "https://s3.in-memory.test";

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const [named, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const key = rest.join("/");

    if (named !== bucket) return error("NoSuchBucket", 404);

    if (url.searchParams.has("X-Amz-Signature")) {
      if (!(await presignedByUs(url, request.method))) return error("SignatureDoesNotMatch", 403);
    } else if (!request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) {
      return error("AccessDenied", 403);
    }

    // The bucket itself: probed for existence, and listed.
    if (key === "") {
      if (request.method === "HEAD") return new Response(null, { status: 200 });
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        return listing(url);
      }
      return new Response(null, { status: 405 });
    }

    const stored = objects.get(key);
    const headersFor = (object: StoredBytes) => ({
      "content-length": String(object.bytes.byteLength),
      etag: entityTagOf(object.bytes),
      "content-type": object.contentType,
      ...(object.contentDisposition ? { "content-disposition": object.contentDisposition } : {}),
      ...(object.cacheControl ? { "cache-control": object.cacheControl } : {}),
    });

    switch (request.method) {
      case "HEAD":
        if (!stored) return error("NoSuchKey", 404);
        return new Response(null, { status: 200, headers: headersFor(stored) });

      case "GET": {
        if (!stored) return error("NoSuchKey", 404);
        const matching = request.headers.get("if-match");
        if (matching && matching !== entityTagOf(stored.bytes)) {
          return error("PreconditionFailed", 412);
        }
        return new Response(stored.bytes, { status: 200, headers: headersFor(stored) });
      }

      case "PUT": {
        const source = request.headers.get("x-amz-copy-source");
        if (!source) {
          objects.set(key, {
            bytes: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") ?? "binary/octet-stream",
            writtenAt: new Date(),
          });
          return new Response(null, {
            status: 200,
            headers: { etag: entityTagOf(objects.get(key)!.bytes) },
          });
        }

        const from = decodeURIComponent(source).replace(new RegExp(`^/${bucket}/`), "");
        const original = objects.get(from);
        if (!original) return error("NoSuchKey", 404);
        const matching = request.headers.get("x-amz-copy-source-if-match");
        if (matching && matching !== entityTagOf(original.bytes)) {
          return error("PreconditionFailed", 412);
        }

        // Only `REPLACE` is used here, and only with both headers set.
        const replacing = request.headers.get("x-amz-metadata-directive") === "REPLACE";
        objects.set(key, {
          bytes: original.bytes,
          writtenAt: new Date(),
          contentType: replacing
            ? (request.headers.get("content-type") ?? "binary/octet-stream")
            : original.contentType,
          contentDisposition: replacing
            ? (request.headers.get("content-disposition") ?? undefined)
            : original.contentDisposition,
          cacheControl: replacing
            ? (request.headers.get("cache-control") ?? undefined)
            : original.cacheControl,
        });
        return xml(
          `<CopyObjectResult><ETag>${entityTagOf(original.bytes)}</ETag></CopyObjectResult>`,
          200,
        );
      }

      case "DELETE":
        if (!stored) return error("NoSuchKey", 404);
        objects.delete(key);
        return new Response(null, { status: 204 });

      default:
        return error("MethodNotAllowed", 405);
    }
  };

  /**
   * `ListObjectsV2`, two keys to a page.
   *
   * Deliberately smaller pages than S3's thousand, so that a caller which
   * stopped at the first page — and called the rest of the bucket unclaimed —
   * fails here rather than in a deployment.
   */
  const listing = (url: URL) => {
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("continuation-token") ?? "";
    const matching = [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix) && key > after)
      .sort(([a], [b]) => (a < b ? -1 : 1));

    const page = matching.slice(0, 2);
    const truncated = matching.length > page.length;
    const contents = page
      .map(
        ([key, object]) =>
          `<Contents><Key>${key}</Key>` +
          `<LastModified>${(object.writtenAt ?? new Date()).toISOString()}</LastModified>` +
          `<Size>${object.bytes.byteLength}</Size></Contents>`,
      )
      .join("");
    return xml(
      `<ListBucketResult>${contents}<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${page.at(-1)![0]}</NextContinuationToken>` : "") +
        `</ListBucketResult>`,
      200,
    );
  };

  return {
    objects,
    client: (url, init) => serve(new Request(url, init)),
    configuration: { bucket, region, accessKeyId, secretAccessKey, endpoint, fetch: serve },
  };
}

/**
 * The store a test hands `createApp`, and the S3 behind it.
 *
 * Every suite that builds an app needs one, and it is the real implementation
 * over the fake wire rather than a stand-in for the interface.
 */
export function inMemoryObjectStore(bucket?: string): InMemoryS3 & { store: ObjectStore } {
  const s3 = inMemoryS3(bucket);
  return { ...s3, store: objectStoreInS3(s3.configuration) };
}

/** Step one: ask for permission to upload, and a URL to upload to. */
export const prepareUpload = (
  request: TestRequest,
  evidenceId: string,
  details: UploadDetails = {},
) =>
  request(`/evidence/${evidenceId}/file-uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "minutes.txt", ...details }),
  });

/** Step two: send the bytes. Answers the upload's identifier. */
export async function sendBytes(
  s3: InMemoryS3,
  prepared: Response,
  contents: string | Uint8Array = "the minutes",
): Promise<string> {
  const { data } = (await prepared.json()) as { data: { id: string; upload: { url: string } } };
  const sent = await s3.client(data.upload.url, { method: "PUT", body: contents });
  if (sent.status !== 200) throw new Error(`the store refused the upload: ${sent.status}`);
  return data.id;
}

/** Step three: attach what arrived. */
export const completeUpload = (request: TestRequest, uploadId: string) =>
  request(`/file-uploads/${uploadId}/completion`, { method: "PUT" });

/**
 * Steps one and two, for a test whose subject is the completion.
 *
 * Throws rather than answers a refusal: a suite using this has already decided
 * the upload itself is not what is under test.
 */
export async function uploadedBytes(
  s3: InMemoryS3,
  request: TestRequest,
  evidenceId: string,
  contents?: string | Uint8Array,
  details: UploadDetails = {},
): Promise<string> {
  const prepared = await prepareUpload(request, evidenceId, details);
  if (prepared.status !== 201) throw new Error(`the upload was not authorized: ${prepared.status}`);
  return sendBytes(s3, prepared, contents);
}

/**
 * All three requests attaching a file takes, as a test makes them.
 *
 * Every suite that needs an attachment needs all three, and a suite that
 * inlined them would read as though the sequence were what it was about.
 * `request` is already bound to a tenant. Answers whichever response ended the
 * sequence: the refusal, or the completion carrying the file.
 */
export async function attachFile(
  s3: InMemoryS3,
  request: TestRequest,
  evidenceId: string,
  contents?: string | Uint8Array,
  details: UploadDetails = {},
): Promise<Response> {
  const prepared = await prepareUpload(request, evidenceId, details);
  if (prepared.status !== 201) return prepared;
  return completeUpload(request, await sendBytes(s3, prepared, contents));
}

type UploadDetails = { filename?: string; contentType?: string; bytes?: number };

/**
 * Loose on purpose: every suite has a `request` of its own shape, bound to its
 * own tenant, and this asks only for what it calls.
 */
type TestRequest = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response> | Response;
