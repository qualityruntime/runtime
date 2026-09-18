// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Client, Pool } from "pg";
import * as schema from "./schema/index.ts";

/**
 * A Drizzle handle on this schema.
 *
 * Query code takes this type rather than a connection of its own, so a test can
 * hand it a handle bound to a throwaway database. A transaction satisfies it,
 * which is what lets a query run inside `withOrganization`.
 *
 * The driver is a parameter because the handles here come from two:
 * node-postgres in a deployment, PGlite in tests.
 */
export type Database<Q extends PgQueryResultHKT = NodePgQueryResultHKT> = PgDatabase<
  Q,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

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
