// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a deployment has to tell this process, read once and in one place.
 *
 * Deployment-specific by design: core code is handed its configuration and
 * never reads an environment (ARCH-01). Every entry point needs the same
 * object store, and a second copy of these names would be a second thing for
 * `docs/deployment.md` to disagree with.
 */

import { bucketBase, type S3Configuration } from "./objects-in-s3.ts";

/** Fails at start-up rather than on the first request that needs the value. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 * Refuses a bucket the browser would send the session cookie to.
 *
 * The cookie's path is depth and not a boundary, and a hostname of the store's
 * own is the boundary (`docs/security.md`). What depth cannot cover is this
 * host inside that path: a download answers `303` to somewhere the cookie
 * matches, and the browser attaches it.
 *
 * Judged on the bucket's URL rather than the endpoint's, because the bucket is
 * a path segment of it — endpoint `https://this.host` with bucket `api` is the
 * same configuration written a second way. Another port of this host is the
 * development setup, answers below `/`, and is left alone.
 *
 * `cookiePath` is passed rather than repeated here so that the string this
 * judges is the one `auth.ts` actually sets.
 */
export function assertStorageOutsideCookiePath(
  storage: S3Configuration,
  baseURL: string,
  cookiePath: string,
): void {
  const bucket = new URL(bucketBase(storage));
  if (bucket.hostname !== new URL(baseURL).hostname) return;
  // To a segment boundary, as a cookie path matches: `/apistorage` is elsewhere.
  if (bucket.pathname !== cookiePath && !bucket.pathname.startsWith(`${cookiePath}/`)) return;

  throw new Error(
    `STORAGE_ENDPOINT and STORAGE_BUCKET put the bucket at "${bucket.href}", inside this ` +
      `server's own "${cookiePath}", which is where the session cookie is sent. Give the ` +
      "object store a hostname of its own.",
  );
}

/**
 * The bucket this deployment keeps file bytes in.
 *
 * One namespace rather than AWS's own names, because the store is a contract
 * this product depends on and not a vendor it is coupled to. `STORAGE_ENDPOINT`
 * is what points it at Cloudflare R2, MinIO, Backblaze B2 or anything else
 * speaking the same protocol; left unset, it addresses AWS S3 itself.
 */
export function storageConfiguration(): S3Configuration {
  return {
    bucket: requireEnv("STORAGE_BUCKET"),
    region: requireEnv("STORAGE_REGION"),
    accessKeyId: requireEnv("STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("STORAGE_SECRET_ACCESS_KEY"),
    endpoint: process.env.STORAGE_ENDPOINT,
  };
}
