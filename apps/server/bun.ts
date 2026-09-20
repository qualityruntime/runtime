// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bun entry point: the deployment adapter for a long-lived server process.
 *
 * Reads deployment configuration and owns the connection pool for the life of
 * the process; core code depends on neither this entry point nor its environment
 * (ARCH-01).
 */

import { assertTenantIsolation, createDatabase } from "@qualityruntime/db";
import { Pool } from "pg";
import { createApp } from "./app.ts";
import { createAuth, sessionCookiePath } from "./auth.ts";
import { assertStorageOutsideCookiePath, requireEnv, storageConfiguration } from "./environment.ts";
import { assertBucket, objectStoreInS3 } from "./objects-in-s3.ts";

// This process owns the pool; `packages/db` only binds Drizzle to it.
const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
const db = createDatabase(pool);

// A role that bypasses row-level security disables tenant isolation silently,
// so refuse to start rather than serve without it (ADR 0003).
await assertTenantIsolation(db);

// Refuse a bucket the browser would hand the session cookie to on its way to a
// download — before anything signs a request to it (ADR 0021).
const storage = storageConfiguration();
assertStorageOutsideCookiePath(storage, requireEnv("BETTER_AUTH_URL"), sessionCookiePath);

// And a bucket that cannot be reached looks exactly like every file having been
// deleted, so refuse to start rather than fail every download (ADR 0021).
await assertBucket(storage);

export default createApp({
  db,
  // Where the bucket is, and which one, is the deployment's to choose; the
  // core knows only the interface (ADR 0021).
  store: objectStoreInS3(storage),
  // Optional, unlike the rest: the reference falls back to the public CDN.
  apiReferenceBundleUrl: process.env.API_REFERENCE_BUNDLE_URL,
  auth: createAuth(db, {
    baseURL: requireEnv("BETTER_AUTH_URL"),
    secret: requireEnv("BETTER_AUTH_SECRET"),
  }),
});
