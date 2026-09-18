// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bun entry point: the deployment adapter for a long-lived server process.
 *
 * Deployment-specific by design — it reads the environment and owns a
 * connection pool for the life of the process. A Workers entry would sit
 * beside this file and build a per-request client behind Hyperdrive instead
 * (ARCH-01).
 */

import { assertTenantIsolation, createDatabase } from "@qualityruntime/db";
import { Pool } from "pg";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

/** Fails at start-up rather than on the first request that needs the value. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

// This process owns the pool; `packages/db` only binds Drizzle to it.
const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
const db = createDatabase(pool);

// A role that bypasses row-level security disables tenant isolation silently,
// so refuse to start rather than serve without it (ADR 0003).
await assertTenantIsolation(db);

export default createApp({
  db,
  // Optional, unlike the rest: the reference falls back to the public CDN.
  apiReferenceBundleUrl: process.env.API_REFERENCE_BUNDLE_URL,
  auth: createAuth(db, {
    baseURL: requireEnv("BETTER_AUTH_URL"),
    secret: requireEnv("BETTER_AUTH_SECRET"),
  }),
});
