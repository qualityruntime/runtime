// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable storage for the bytes of a file.
 *
 * The first runtime capability here, and the shape of every later one: a narrow
 * interface the core depends on, implemented by a deployment adapter (ARCH-01).
 * PostgreSQL keeps what a file is, who it belongs to and who may read it;
 * this keeps only the bytes, addressed by a key PostgreSQL issued.
 *
 * Reasoning: `docs/adr/0013-durable-storage.md`.
 */

import { createHash } from "node:crypto";

/** What a store needs to know about the bytes it is given. */
export type StoredFile = {
  /** Bytes written, counted while writing rather than taken on trust. */
  bytes: number;
  /** Lowercase hex SHA-256 of what was written. */
  checksum: string;
};

export type FileStore = {
  /**
   * Writes `body` under `key`, returning what was actually written.
   *
   * Streams: a file is not read into memory to be stored. `limit` is a cap on
   * bytes, enforced as they arrive — a `Content-Length` is a claim, and the
   * only honest bound is the one counted. Exceeding it throws, and nothing is
   * left behind.
   */
  put(key: string, body: ReadableStream<Uint8Array>, limit: number): Promise<StoredFile>;

  /** The bytes under `key`, or null if there are none. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Removes the bytes under `key`, if any.
   *
   * For cleaning up after a write whose database row never landed, not for
   * deleting a file someone can see: what may be removed is decided in
   * PostgreSQL, and a row that is still there is a file that still exists.
   */
  discard(key: string): Promise<void>;
};

/**
 * The SHA-256 of a stream, as `put` records it.
 *
 * Here rather than beside either caller, so that what "the checksum" means is
 * written once: an adapter computes it while writing, and `integrity.ts`
 * recomputes it while reading, and the two have to agree to mean anything.
 */
export async function checksumOf(body: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of body) hash.update(chunk);
  return hash.digest("hex");
}

/** Thrown by `put` when more bytes arrive than were allowed. */
export class TooManyBytes extends Error {
  constructor(readonly limit: number) {
    super(`More than ${limit} bytes were sent.`);
    this.name = "TooManyBytes";
  }
}
