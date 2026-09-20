// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `ObjectStore`, over the S3-compatible protocol.
 *
 * The only implementation there is. AWS S3, Cloudflare R2, MinIO and Backblaze
 * B2 differ in their endpoint and their region and not in the handful of
 * requests this makes, so one implementation configured with an endpoint
 * reaches all of them and there is no adapter per vendor (ADR 0021).
 *
 * Documented is not demonstrated: a provider counts as supported only once
 * `storage-integration.test.ts` has passed against it. CI asks MinIO on every
 * push, `.github/workflows/storage-compatibility.yml` is the register of which
 * others have been asked, and the rest are configurations that ought to work.
 *
 * Nothing here is Node's: requests are `fetch`, and signing is `aws4fetch`,
 * which uses Web Crypto. The same file runs on Bun and on a Worker, and
 * `fetch` is a parameter so a test can hand it an S3 answering in memory —
 * through this same implementation, signing and preconditions included.
 */

import { AwsClient } from "aws4fetch";
import {
  attachmentNamed,
  ObjectChanged,
  type ObjectStore,
  type StoredKey,
  type StoredPrefix,
} from "./objects.ts";

export type S3Configuration = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The store's base URL, absent only for AWS S3 itself.
   *
   * Its presence also decides how a bucket is addressed: an endpoint is asked
   * for `{endpoint}/{bucket}/{key}`, which every S3-compatible store answers
   * and which needs no DNS of its own, while AWS is addressed by virtual host.
   * That is why there is no path-style switch to set (ADR 0021).
   */
  endpoint?: string;
  /**
   * How a signed request is made. The global `fetch` unless a test says
   * otherwise, and the narrow shape is deliberate: this asks the environment
   * for one thing, and every environment the product runs in has it.
   */
  fetch?: (request: Request) => Promise<Response>;
};

/**
 * Keys this store will touch: the two `objects.ts` builds, and nothing else.
 *
 * Every key is derived from an identifier `packages/db` issued, never from a
 * caller, and this is what keeps that true even if one day it is not.
 */
const isKey = /^(?:uploads\/upl|files\/fil)_[0-9a-z]{16}$/;

/** The prefixes `list` will ask for, checked as keys are and for the reason. */
const prefixes: readonly StoredPrefix[] = ["uploads/", "files/"];

/** How long a request that is not a byte stream may take. */
const requestTimeout = 30_000;

/**
 * How long a request whose answer is a byte stream may take, in full.
 *
 * The whole transfer rather than the gaps between chunks, because a stall
 * detector is machinery and 25 MiB in five minutes is 85 KB/s — slower than
 * any link between a runtime and its own bucket. It rules out the read that
 * never finishes, which nothing else here bounds.
 */
const transferTimeout = 5 * 60_000;

/** Percent-encodes a key for a URL path without encoding its separator. */
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/**
 * Where this bucket answers: every key is a path below it.
 *
 * Exported because the check that a download stays off the session cookie's
 * path has to ask the same question — a second idea of where the bucket lives
 * would be a second place to get it wrong (`assertStorageOutsideCookiePath`).
 */
export function bucketBase({ bucket, region, endpoint }: S3Configuration): string {
  // AWS allows a period in a bucket name and then cannot serve it: its
  // wildcard certificate covers one label, so `https://a.b.s3.…` fails
  // verification. Refused here, because the alternative is an opaque TLS error
  // at start-up. A bucket named that way is reachable through an endpoint.
  if (!endpoint && bucket.includes(".")) {
    throw new Error(
      `STORAGE_BUCKET "${bucket}" contains a period, which AWS S3 cannot serve over HTTPS ` +
        "by virtual host. Rename the bucket, or set STORAGE_ENDPOINT.",
    );
  }
  return endpoint
    ? `${endpoint.replace(/\/+$/, "")}/${bucket}`
    : `https://${bucket}.s3.${region}.amazonaws.com`;
}

/** What both the store and the start-up probe need to speak to the bucket. */
function s3(configuration: S3Configuration) {
  const { region, accessKeyId, secretAccessKey } = configuration;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region });
  const send = configuration.fetch ?? fetch;
  const base = bucketBase(configuration);

  const assertKey = (key: string) => {
    if (!isKey.test(key)) throw new Error(`"${key}" is not a storage key.`);
    return key;
  };
  const urlOf = (key: string) => `${base}/${encodeKey(assertKey(key))}`;

  /** A signed request, made. Every one carries a deadline; a stream gets longer. */
  const request = async (url: string, init: RequestInit & { streaming?: boolean }) => {
    const { streaming = false, ...rest } = init;
    // Signing carries the signal through, so the deadline is on the request
    // itself rather than an argument only some `fetch` implementations read.
    const signal = AbortSignal.timeout(streaming ? transferTimeout : requestTimeout);
    return send(await aws.sign(url, { ...rest, signal }));
  };

  /** A URL carrying its own authorization, good for `expiresIn` seconds. */
  const presign = async (key: string, method: "GET" | "PUT", expiresIn: number) => {
    const url = new URL(urlOf(key));
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    const signed = await aws.sign(url.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  };

  return { assertKey, base, urlOf, request, presign };
}

/**
 * What went wrong, with the store's own words and without its credentials.
 *
 * An S3 error is XML naming the code and the key. It is worth keeping — half of
 * operating this is telling `NoSuchBucket` from `SignatureDoesNotMatch` — and a
 * URL is not, because a signed one carries a signature.
 */
async function refuse(what: string, response: Response): Promise<never> {
  const detail = await response.text().catch(() => "");
  throw new Error(
    `${what} failed: ${response.status} ${response.statusText}. ${detail.slice(0, 500)}`,
  );
}

/**
 * The entity tag a `CopyObjectResult` names, spelled as HTTP spells one.
 *
 * Providers disagree on the XML: an entity tag contains quotes, AWS escapes
 * them `&quot;`, and MinIO's Go encoder writes `&#34;` for the same character.
 * This value goes straight back out as `If-Match`, so an undecoded one is a
 * precondition that cannot match and a promotion that cannot be read back.
 *
 * Re-quoted rather than passed through, because an entity tag is quoted
 * (RFC 9110) and a provider that omits them would otherwise send a bare token.
 */
function entityTagIn(body: string): string | undefined {
  const raw = body.match(/<CopyObjectResult[\s\S]*?<ETag>([^<]+)<\/ETag>/)?.[1];
  if (!raw) return undefined;
  // `&amp;` last: decoding it first would turn `&amp;quot;` into a quote.
  const decoded = raw.replaceAll("&quot;", '"').replaceAll("&#34;", '"').replaceAll("&amp;", "&");
  const inner = /^"(.*)"$/.exec(decoded.trim())?.[1] ?? decoded.trim();
  return inner ? `"${inner}"` : undefined;
}

/** Releases a response whose body is not going to be read. */
const drop = (response: Response) => response.body?.cancel().catch(() => undefined);

/**
 * The objects one `ListObjectsV2` page named.
 *
 * Parsed with a pattern rather than an XML parser, because the shape is three
 * fields inside `<Contents>` and a dependency for that would be a dependency to
 * keep. Every key this acts on is checked against `isKey` afterwards, so a
 * malformed or unexpected entry is skipped rather than misread.
 */
function* listed(xml: string): Generator<StoredKey> {
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const entry = match[1]!;
    const key = entry.match(/<Key>([^<]*)<\/Key>/)?.[1];
    const bytes = Number(entry.match(/<Size>(\d+)<\/Size>/)?.[1]);
    const written = Date.parse(entry.match(/<LastModified>([^<]*)<\/LastModified>/)?.[1] ?? "");
    if (!key || !Number.isSafeInteger(bytes) || Number.isNaN(written)) continue;
    yield { key, bytes, writtenAt: new Date(written) };
  }
}

export function objectStoreInS3(configuration: S3Configuration): ObjectStore {
  const { bucket } = configuration;
  const { base, assertKey, urlOf, request, presign } = s3(configuration);

  return {
    async signedUpload(key, { expiresIn }) {
      return { method: "PUT", url: await presign(key, "PUT", expiresIn) };
    },

    async inspect(key) {
      const response = await request(urlOf(key), { method: "HEAD" });
      if (response.status === 404) {
        await drop(response);
        return null;
      }
      if (!response.ok) await refuse(`HEAD ${key}`, response);

      // The length the store reports, never one a client declared. A missing
      // header is refused rather than read as zero, which is how a 25 MiB
      // object would otherwise be taken for an empty one.
      const declared = response.headers.get("content-length");
      const bytes = Number(declared);
      const entityTag = response.headers.get("etag");
      if (declared === null || !Number.isSafeInteger(bytes) || bytes < 0 || !entityTag) {
        throw new Error(`HEAD ${key} answered without a usable length and entity tag.`);
      }
      return { bytes, entityTag };
    },

    async read(key, { matching } = {}) {
      const response = await request(urlOf(key), {
        method: "GET",
        headers: matching ? { "if-match": matching } : undefined,
        // The body is the point, and it may be 25 MiB over a slow link — so a
        // longer deadline, but a deadline.
        streaming: true,
      });
      // 404 without a version asked for is simply an absence; with one, the
      // object that was inspected has gone, which is a change like any other.
      // 412 is the object being there and being different.
      if (response.status === 404 || response.status === 412) {
        await drop(response);
        if (!matching && response.status === 404) return null;
        throw new ObjectChanged(key);
      }
      if (!response.ok) await refuse(`GET ${key}`, response);
      if (!response.body) throw new Error(`GET ${key} answered without a body.`);
      return response.body;
    },

    async promote(from, to, { matching, filename }) {
      const response = await request(urlOf(to), {
        method: "PUT",
        headers: {
          // `from` travels in a header rather than in the URL, so it is checked
          // here: `urlOf` sees only `to`, and a key is a key wherever it goes.
          "x-amz-copy-source": `/${bucket}/${encodeKey(assertKey(from))}`,
          // So that the object inspected and the object copied are one object.
          "x-amz-copy-source-if-match": matching,
          "x-amz-metadata-directive": "REPLACE",
          // How the permanent object will be served, fixed here rather than
          // asked for at download time: response overrides on a signed URL are
          // not uniform across providers, and this is (ADR 0021). A tenant
          // chooses the bytes; this origin does not render them.
          "content-type": "application/octet-stream",
          "content-disposition": attachmentNamed(filename),
          // A signed download is a bearer capability with a minute's life, and
          // a response no policy forbids storing may be cached heuristically.
          // Set here for the same reason the other two are: a response
          // override on the URL is not uniform across providers.
          "cache-control": "private, no-store",
        },
      });
      // The source is gone, or is no longer the version that was inspected.
      if (response.status === 412 || response.status === 404) {
        await drop(response);
        throw new ObjectChanged(from);
      }
      if (!response.ok) await refuse(`copy ${from} to ${to}`, response);

      // A copy may fail after the status line: S3 answers 200, holds the
      // connection open while it works, and reports the failure in the body,
      // so a promotion believed on its status alone would leave a row naming
      // an object never written. The tag in that body is the destination's, so
      // reading it out is both the proof it finished and what callers pin to.
      const body = await response.text();
      const entityTag = entityTagIn(body);
      if (!entityTag) {
        throw new Error(`copy ${from} to ${to} failed after answering 200. ${body.slice(0, 500)}`);
      }
      return { entityTag };
    },

    async *list(prefix) {
      // Narrow in the type and again here: a listing is the one request that
      // reaches beyond a key this product issued, and a bucket may be shared.
      if (!prefixes.includes(prefix)) throw new Error(`"${prefix}" is not a storage prefix.`);

      // Paged by the store, a thousand keys at a time. Followed to the end
      // rather than stopping at the first page: a sweep that saw only part of
      // a bucket would call the rest of it unclaimed.
      let continuation: string | undefined;
      do {
        const url = new URL(base);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (continuation) url.searchParams.set("continuation-token", continuation);

        const response = await request(url.toString(), { method: "GET" });
        if (!response.ok) await refuse(`listing ${prefix}`, response);
        const page = await response.text();

        // Believed only when it is recognisably a listing and says outright
        // whether it is the whole of one. AWS documents a 200 that carries
        // invalid XML, and every reading of a short listing here is a report
        // that a bucket holds less than it does.
        if (!page.includes("<ListBucketResult")) {
          throw new Error(`listing ${prefix} answered 200 with something that is not a listing.`);
        }
        const truncated = page.match(/<IsTruncated>\s*(true|false)\s*<\/IsTruncated>/)?.[1];
        if (!truncated) {
          throw new Error(`listing ${prefix} does not say whether it is truncated.`);
        }

        yield* listed(page);
        if (truncated === "false") return;

        // Truncated and unreadable. Stopping here would report part of a
        // bucket as all of it, and the only caller that acts on a listing acts
        // by deleting what it did not see claimed.
        continuation = page.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1];
        if (!continuation) {
          throw new Error(`listing ${prefix} is truncated and names no continuation token.`);
        }
      } while (continuation);
    },

    async signedDownload(key, { expiresIn }) {
      return presign(key, "GET", expiresIn);
    },

    async discard(key) {
      const response = await request(urlOf(key), { method: "DELETE" });
      // A store that has nothing under the key has done what was asked.
      if (response.ok || response.status === 404) {
        await drop(response);
        return;
      }
      // Not dropped first: the store's own words are in the body, and this is
      // the one place that has to explain why bytes could not be cleaned up.
      await refuse(`DELETE ${key}`, response);
    },
  };
}

/**
 * Refuses a bucket that is not there, before anything reads it.
 *
 * A misconfigured bucket, endpoint or key pair is indistinguishable from every
 * file having been deleted: downloads 404 and `verify:files` reports the whole
 * deployment as missing and sends an operator to the backups. Cheaper to rule
 * out once, at start-up, the way `assertTenantIsolation` does.
 *
 * Deliberately does not create the bucket. A bucket the runtime made is one the
 * operator has not configured for retention, and bucket policy is theirs.
 *
 * `HEAD` on the bucket is `HeadBucket`, which wants `s3:ListBucket` — so the
 * key pair a deployment configures needs it, and `docs/deployment.md` says so.
 */
export async function assertBucket(configuration: S3Configuration): Promise<void> {
  const { base, request } = s3(configuration);

  let response: Response;
  try {
    response = await request(base, { method: "HEAD" });
  } catch (error) {
    throw new Error(`The bucket ${configuration.bucket} could not be reached: ${String(error)}`);
  }
  await drop(response);
  if (!response.ok) {
    throw new Error(
      `The bucket ${configuration.bucket} answered ${response.status} ${response.statusText}. ` +
        "Check STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_REGION and the access key.",
    );
  }
}
