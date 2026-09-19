// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A `FileStore` on a mounted volume.
 *
 * The canonical self-hosted deployment is meant to need PostgreSQL and a
 * directory, and nothing else — so this is the adapter that has to exist.
 * Deployment-specific by design: the core depends on the interface, never on
 * this (ARCH-01).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { type FileStore, TooManyBytes } from "./storage.ts";

/**
 * Keys this store will touch: exactly the identifiers `packages/db` generates.
 *
 * A key becomes a path, so nothing else may be one. Every key here is issued by
 * the database rather than supplied by a caller, and this is what keeps that
 * true even if one day it is not.
 */
const isKey = /^[a-z]{2,8}_[0-9a-z]{16,24}$/;

/**
 * Two levels of fan-out, on the random part of the key.
 *
 * A directory holding every file an organization ever uploaded is one some
 * filesystems handle badly and every operator dreads listing.
 */
function pathOf(root: string, key: string): string {
  if (!isKey.test(key)) throw new Error(`"${key}" is not a storage key.`);
  const random = key.slice(key.indexOf("_") + 1);
  return join(root, random.slice(0, 2), random.slice(2, 4), key);
}

/**
 * Refuses a volume that is not there, before anything reads it.
 *
 * An unmounted volume or a mistyped `STORAGE_DIRECTORY` is indistinguishable
 * from every file having been deleted: `get` answers null for all of them, so
 * the server 404s every download and `verify:files` reports the whole
 * deployment as missing and tells the operator to go find what wrote to it.
 * Cheaper to rule out once, at start-up, the way `assertTenantIsolation` does.
 *
 * Deliberately does not create the directory. A volume that has to be created
 * is one that was not mounted.
 */
export async function assertVolume(directory: string): Promise<void> {
  const root = resolve(directory);
  const failed = (why: string) =>
    new Error(`STORAGE_DIRECTORY ${root} ${why}. Is the volume mounted?`);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(root);
  } catch {
    throw failed("does not exist");
  }
  if (!stats.isDirectory()) throw failed("is not a directory");
}

/** Persists a directory's entries — a rename or a new subdirectory — to disk. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function fileStoreOnDisk(directory: string): FileStore {
  const root = resolve(directory);

  return {
    async put(key, body, limit) {
      const path = pathOf(root, key);
      // Written beside its destination and renamed, so no reader ever finds a
      // half-written file under a key: a rename within a filesystem is atomic.
      const pending = `${path}.partial`;
      await mkdir(dirname(path), { recursive: true });

      const handle = await open(pending, "w");
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          // Counted as they arrive. A `Content-Length` is a claim; this is not.
          if (bytes > limit) throw new TooManyBytes(limit);
          hash.update(chunk);
          // A write may take less than it was given, and the size and checksum
          // above describe all of it.
          for (let offset = 0; offset < chunk.byteLength;) {
            const { bytesWritten } = await handle.write(chunk, offset);
            if (bytesWritten === 0) throw new Error(`Nothing written to ${pending}.`);
            offset += bytesWritten;
          }
        }
        // Durable before it is acknowledged: the caller commits the row next,
        // and a crash must not leave a committed file whose bytes were only in
        // a cache. Every directory up to the root is synced, not only ones this
        // call created: another upload may have created them and not synced
        // them yet, or failed before it could.
        await handle.sync();
        await handle.close();
        await rename(pending, path);
        for (const directory of [dirname(path), dirname(dirname(path)), root]) {
          await syncDirectory(directory);
        }
        return { bytes, checksum: hash.digest("hex") };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(pending, { force: true });
        throw error;
      }
    },

    async get(key) {
      const path = pathOf(root, key);
      try {
        // Regular files only. Whatever can write to this volume can also put a
        // FIFO here, and opening one blocks until a writer appears — a reader
        // that waits forever, in a request or in `verify:files`, is a worse
        // answer than "there are no bytes here".
        if (!(await stat(path)).isFile()) return null;
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    },

    async discard(key) {
      await rm(pathOf(root, key), { force: true });
    },
  };
}
