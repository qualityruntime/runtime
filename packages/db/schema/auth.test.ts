// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards the hand-maintained Drizzle tables against the schema Better Auth
 * actually writes, so a library upgrade that adds or renames a field fails here
 * in CI rather than when the adapter initializes.
 */

import { getAuthTables } from "better-auth/db";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { getTableColumns, is, Table } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { idFormats } from "../id.ts";
import * as schema from "./index.ts";

// The future server configuration must use this same schema-affecting plugin
// configuration — options such as `teams` add tables — since it defines the
// schema contract tested here.
const expected = getAuthTables({
  plugins: [organization(), admin(), twoFactor()],
});

describe.each(Object.entries(expected))("%s", (key, table) => {
  const name = table.modelName || key;
  // Better Auth's Drizzle adapter finds a table by the key it is exported
  // under, not by its physical name.
  const exported = (schema as Record<string, unknown>)[name];

  it("is exported under the name the adapter looks up", () => {
    expect(is(exported, Table)).toBe(true);
  });

  it("has an identifier format", () => {
    // Better Auth asks `id.ts` for an id under the model name, so a table
    // it writes without a format here throws on its first insert.
    expect(Object.keys(idFormats)).toContain(key);
  });

  it("has a column for every field Better Auth writes", () => {
    const columns = getTableColumns(exported as Table);
    const written = Object.entries(table.fields).map(
      ([field, attribute]) => attribute.fieldName || field,
    );
    expect(Object.keys(columns)).toEqual(expect.arrayContaining(written));
  });

  it("accepts an insert that omits every column Better Auth does not write", () => {
    const columns = getTableColumns(exported as Table);
    const written = new Set([
      "id",
      ...Object.entries(table.fields).map(([field, attribute]) => attribute.fieldName || field),
    ]);
    const unsatisfiable = Object.entries(columns)
      .filter(([column]) => !written.has(column))
      .filter(([, column]) => column.notNull && !column.hasDefault)
      .map(([column]) => column);
    expect(unsatisfiable).toEqual([]);
  });
});
