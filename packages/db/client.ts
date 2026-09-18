// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { drizzle } from "drizzle-orm/node-postgres";
import type { Client, Pool } from "pg";
import * as schema from "./schema/index.ts";

/**
 * A Drizzle handle bound to a connection.
 *
 * Query code takes this type rather than a connection of its own, so a test can
 * hand it a handle bound to a throwaway database.
 */
export type Database = ReturnType<typeof createDatabase>;

/**
 * Binds Drizzle to a connection the caller owns.
 *
 * Connection lifecycle stays with the deployment (ARCH-01): a long-lived `Pool`
 * suits a Node or Bun server, while a Worker behind Hyperdrive wants a `Client`
 * per request. This package has no way to choose correctly between them, and
 * picking one here would put a deployment concern in the core.
 */
export function createDatabase(client: Client | Pool) {
  return drizzle({ client, schema, casing: "snake_case" });
}
