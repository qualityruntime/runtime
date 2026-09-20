// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The object store that holds the bytes of a file.
 *
 * A runtime capability the core depends on, implemented once against the
 * S3-compatible protocol and configured by the deployment (ARCH-01). PostgreSQL
 * keeps what a file is, whose it is and who may read it; this keeps only bytes,
 * under keys this product issued (DATA-01).
 *
 * The shape follows the upload lifecycle rather than a filesystem: a client
 * uploads to a temporary key with a signed request, the runtime inspects and
 * reads what arrived, and the permanent object is made here by copying — so no
 * permanent key is ever signed for writing.
 *
 * Reasoning: `docs/adr/0021-file-bytes-in-object-storage.md`.
 */

import { createHash } from "node:crypto";

/**
 * The two namespaces this product keeps objects in, and the whole of them.
 *
 * A bucket may be shared, so a prefix is a closed set rather than a string: a
 * sweep is the one operation here that acts on what it finds rather than on a
 * key it was given, and the blast radius of listing the wrong place is
 * everything else in the bucket.
 */
export type StoredPrefix = "uploads/" | "files/";

/** Where a client's upload lands, before anything is promised about it. */
export const uploadKey = (uploadId: string) => `uploads/${uploadId}`;

/** Where a file's bytes live, for as long as its row does. */
export const fileKey = (fileId: string) => `files/${fileId}`;

/** A request a client may make directly to the store, until it expires. */
export type SignedRequest = {
  method: "PUT";
  url: string;
};

/** What the store knows about an object without reading it. */
export type StoredObject = {
  /** The length the store reports. A pre-filter: what a `file` row records is
   * measured from the permanent object, not from this. */
  bytes: number;
  /**
   * A validator for the object's content, and no more.
   *
   * Not a content hash: entity tags are not SHA-256 and differ across
   * providers and upload shapes. Nor does it name a whole version — S3 says it
   * reflects content and not metadata, so the same bytes re-sent with
   * different headers carry the same tag. It travels as a precondition, so
   * that the object inspected and the object promoted hold the same bytes, and
   * it is never stored (ADR 0021).
   */
  entityTag: string;
};

/** One object a listing named. */
export type StoredKey = {
  key: string;
  bytes: number;
  /**
   * When the store last wrote it. What makes reclaiming safe: an object
   * younger than a transaction that may still be committing is left alone.
   */
  writtenAt: Date;
};

export type ObjectStore = {
  /**
   * A URL a client may `PUT` bytes to, for `expiresIn` seconds.
   *
   * Only ever issued for a temporary key. The signature covers the URL and not
   * the request headers, so a caller may upload with whatever `Content-Type` it
   * likes: promotion replaces it, and pinning one would only break `curl`.
   */
  signedUpload(key: string, options: { expiresIn: number }): Promise<SignedRequest>;

  /** What is stored under `key`, or null if nothing is. */
  inspect(key: string): Promise<StoredObject | null>;

  /**
   * The bytes under `key`, or null if there are none.
   *
   * `matching` requires the content to still be what that tag validates,
   * throwing `ObjectChanged` rather than quietly yielding something else. So a
   * read naming a tag either answers for that content or throws; only one with
   * nothing to hold it to answers null.
   *
   * What it yields is the representation the store serves, which is the stored
   * octets unless something gave the object a `Content-Encoding` — a tag does
   * not cover metadata, so only bucket-write authority can arrange that, and
   * `docs/security.md` puts that outside the boundary.
   */
  read(key: string, options?: { matching?: string }): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Copies the content `matching` validates to `to`, without the bytes leaving
   * the store, and fixes how it will be served: as a download called
   * `filename`, never as something this origin renders.
   *
   * Answers the entity tag of the object it created, so the read that measures
   * it can name the same one. Throws `ObjectChanged` if `from` no longer holds
   * that content.
   */
  promote(
    from: string,
    to: string,
    options: { matching: string; filename: string },
  ): Promise<{ entityTag: string }>;

  /** A URL the bytes under `key` may be read from, for `expiresIn` seconds. */
  signedDownload(key: string, options: { expiresIn: number }): Promise<string>;

  /**
   * Every object under `prefix`, in whatever order the store answers.
   *
   * Only a sweep needs this: PostgreSQL says what exists, and a listing is how
   * the other direction is asked — which bytes no row claims. Paged by the
   * store, one page at a time, so a large bucket is never held in memory.
   */
  list(prefix: StoredPrefix): AsyncIterable<StoredKey>;

  /**
   * Removes the object under `key`, if there is one.
   *
   * For cleaning up bytes no row names — an abandoned upload, a promotion whose
   * transaction was refused — not for deleting a file someone can see. What may
   * be removed is decided in PostgreSQL.
   */
  discard(key: string): Promise<void>;
};

/** Thrown when an object no longer holds the content a precondition named. */
export class ObjectChanged extends Error {
  constructor(readonly key: string) {
    super(`The object at ${key} no longer holds the content the precondition named.`);
    this.name = "ObjectChanged";
  }
}

/**
 * What a stream holds, as `file.checksum` and `file.bytes` record it.
 *
 * One pass for both, and that is the point rather than an economy: a size from
 * `HEAD` and a checksum from a read are two observations, and the row claims
 * they describe one object. Here rather than beside either caller because
 * completion and `integrity.ts` must mean the same thing by it.
 */
export async function measure(
  body: ReadableStream<Uint8Array>,
): Promise<{ checksum: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { checksum: hash.digest("hex"), bytes };
}

/**
 * The `Content-Disposition` a stored object is served with.
 *
 * Two spellings of one name. `filename` is the fallback every client
 * understands, reduced to printable ASCII because a quote or a newline in one
 * is a way to write a header of your own. `filename*` carries the name as it
 * is, percent-encoded UTF-8 (RFC 5987), which is what stops `Überprüfung.pdf`
 * arriving as `_berpr_fung.pdf`; clients that understand it prefer it, and its
 * encoding leaves nothing that could end the header for those that do not.
 *
 * Here rather than in the implementation: it is what keeps a tenant's filename
 * from becoming a response of its own, and promotion is the only place it is
 * set — nothing afterwards repairs it.
 */
export const attachmentNamed = (filename: string) => {
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // `encodeURIComponent` leaves four characters an RFC 5987 `ext-value` does
  // not allow. The others it leaves — `-`, `.`, `_`, `~`, `!` — are allowed.
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};
