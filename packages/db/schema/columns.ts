// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Column and constraint builders every schema file reuses.
 *
 * Not exported from `index.ts`: that module is the table map Drizzle and Better
 * Auth look tables up in, and these are neither.
 */

import { sql } from "drizzle-orm";
import { check, text, timestamp } from "drizzle-orm/pg-core";
import { createId, type IdType, idPattern } from "../id.ts";

/** Drizzle generates omitted ids in application code; raw SQL must supply one. */
export const id = (model: IdType) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => createId(model));

/**
 * Rejects an identifier that does not carry this table's prefix and shape.
 * `sql.raw` because a CHECK is DDL and cannot take a bound parameter.
 */
export const idFormat = (table: string, model: IdType) =>
  check(`${table}_id_format`, sql.raw(`"id" ~ '${idPattern(model)}'`));

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/** Database default on insert; Drizzle refreshes it on update, raw SQL updates must. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();
