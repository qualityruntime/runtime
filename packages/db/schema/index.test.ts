// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal consistency of the schema, with no reference to Better Auth.
 *
 * Compatibility with Better Auth is checked in `apps/server/auth.test.ts`,
 * where the configuration that decides those tables lives.
 */

import { getTableColumns, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { idFormats } from "../id.ts";
import * as schema from "./index.ts";

const tables = Object.entries(schema).filter(([, value]) => is(value, Table)) as [string, Table][];

describe("identifier formats", () => {
  it("refer only to exported tables", () => {
    const missing = Object.keys(idFormats).filter(
      (type) => !is((schema as Record<string, unknown>)[type], Table),
    );
    expect(missing).toEqual([]);
  });

  it("cover every table that has an id column", () => {
    // Every table with a canonical `id` needs an identifier format (ADR 0002).
    // A join table keyed by its foreign keys needs no surrogate identifier and
    // is deliberately allowed.
    const unformatted = tables
      .filter(([key, table]) => "id" in getTableColumns(table) && !(key in idFormats))
      .map(([key]) => key);
    expect(unformatted).toEqual([]);
  });
});
