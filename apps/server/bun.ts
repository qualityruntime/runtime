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

import { createDatabase } from "@qualityruntime/db";
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

export default createApp(
  createAuth(db, {
    baseURL: requireEnv("BETTER_AUTH_URL"),
    secret: requireEnv("BETTER_AUTH_SECRET"),
  }),
);
