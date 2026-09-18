// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * How `/api/v1` collections are paged.
 *
 * A collection is ordered by a key and the identifier that breaks its ties, and
 * paged by a cursor naming the last row of the page before. Collections that
 * record what happened are newest first. Reasoning:
 * `docs/adr/0006-cursor-paged-collections.md`.
 */

import { desc, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * How a collection is ordered, and therefore what a cursor into it means.
 *
 * The `name` says which collection in which order, and is part of the cursor. A
 * position means nothing anywhere else — not in a different ordering, and not
 * in a different collection that happens to be ordered the same way — so a
 * cursor from one is refused rather than quietly answered from the wrong place.
 */
export type Ordering = {
  readonly name: string;
  /** Newest first: every collection so far records what has happened. */
  readonly key: PgColumn;
  readonly id: PgColumn;
  /** The key rendered losslessly as text, for the cursor. */
  readonly keyAsText: SQL<string>;
  /** Whether text coming back is something the cast below will accept. */
  readonly keyIsValid: (value: string) => boolean;
};

/** The shape a timestamp key takes. Says nothing about whether it exists. */
const timestampFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Whether `value` is a real instant PostgreSQL will accept.
 *
 * The shape alone is not enough: `2026-02-30` and hour `25` match it and are
 * rejected by the cast, which would be a 500 for a bad request. Round-tripping
 * through `Date` settles the calendar; year zero is checked separately because
 * JavaScript has one and PostgreSQL does not.
 */
function isRealInstant(value: string): boolean {
  if (!timestampFormat.test(value) || value.startsWith("0000-")) return false;
  // Microseconds are beyond what `Date` holds, so the check runs on the
  // millisecond prefix; the remaining digits are digits either way.
  const millisecond = `${value.slice(0, 23)}Z`;
  const parsed = new Date(millisecond);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === millisecond;
}

/**
 * Newest first — the ordering of a collection that is a record of what has
 * happened rather than a document with an order of its own.
 *
 * `to_char` against UTC rather than a plain `::text` cast, whose output depends
 * on the session's `TimeZone`; and as text rather than through a `Date`, which
 * keeps only milliseconds where PostgreSQL keeps microseconds — a cursor built
 * from one names a position up to 999µs before the row it came from, and every
 * row in that gap is skipped.
 */
export const newestFirst = (collection: string, createdAt: PgColumn, id: PgColumn): Ordering => ({
  name: `${collection}:recent`,
  key: createdAt,
  id,
  keyAsText: sql<string>`to_char(${createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  keyIsValid: isRealInstant,
});

/** The position of a row in a collection's order. */
export type Cursor = { ordering: string; key: string; id: string };

/** Accepts the generated identifier shape, without checking registered prefixes. */
const idFormat = /^[a-z]{2,8}_[0-9a-z]{16,24}$/;

/**
 * A cursor is opaque to clients — `ordering|key|id`, base64url.
 *
 * Opaque because it is a position in an ordering, not a value: it is only
 * meaningful against the same collection in the same order, and a client that
 * takes it apart will break when the ordering changes.
 */
const encodeCursor = ({ ordering, key, id }: Cursor): string =>
  Buffer.from(`${ordering}|${key}|${id}`, "utf8").toString("base64url");

/**
 * The query a collection ordered by `ordering` accepts.
 *
 * A cursor must name this ordering and carry a valid key and identifier shape.
 * Values PostgreSQL refuses — a NUL, a year outside its range — would otherwise
 * turn a bad request into a 500.
 */
export const collectionQuery = (ordering: Ordering) =>
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      // Long enough for any cursor this issues; a megabyte of base64 is not one.
      .max(256)
      .meta({
        description:
          "The nextCursor of a previous page of this same collection. Opaque: it is a position " +
          "in an ordering, not a value; only a well-formed one for this collection is accepted.",
      })
      .transform((value, ctx): Cursor => {
        const parts = Buffer.from(value, "base64url").toString("utf8").split("|");
        const [name = "", key = "", id = ""] = parts;
        if (
          // base64url decoding skips what it cannot read, so a cursor with
          // junk appended would otherwise decode to a genuine one.
          encodeCursor({ ordering: name, key, id }) !== value ||
          parts.length !== 3 ||
          name !== ordering.name ||
          !ordering.keyIsValid(key) ||
          !idFormat.test(id)
        ) {
          ctx.addIssue({ code: "custom", message: "Not a cursor from a previous page." });
          return z.NEVER;
        }
        return { ordering: name, key, id };
      })
      .optional(),
  });

/** Selects the key a cursor is built from, alongside the row's own columns. */
export const cursorAt = (ordering: Ordering) => ordering.keyAsText;

/** The collection's order, for the query that reads it. */
export const orderedBy = (ordering: Ordering) => [desc(ordering.key), desc(ordering.id)] as const;

/**
 * Restricts a query to the rows after `cursor` in the collection's order.
 *
 * A row comparison rather than `key < … or (key = … and id < …)`: PostgreSQL
 * evaluates it against the same column order an index is built in, and it
 * keeps the tie-breaker in the comparison. Offset boundaries shift under
 * concurrent inserts and deletes, which can repeat or skip rows.
 */
export function rowsAfter(ordering: Ordering, cursor: Cursor): SQL {
  return sql`(${ordering.key}, ${ordering.id}) < (${cursor.key}::timestamptz, ${cursor.id}::text)`;
}

/**
 * Splits rows fetched with `limit + 1` into a page and the cursor after it.
 *
 * Asking for one more row than the page holds is how the last page is known
 * exactly, without a second query and without a count that would be wrong by
 * the time it was read. `cursorAt` is dropped on the way out: it is how a page
 * is found, not something a caller asked for.
 */
export function page<T extends { id: string; cursorAt: string }>(
  rows: T[],
  limit: number,
  ordering: Ordering,
) {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);

  return {
    rows: kept.map((row) => {
      const { cursorAt: position, ...rest } = row;
      void position;
      return rest as Omit<T, "cursorAt">;
    }),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ ordering: ordering.name, key: last.cursorAt, id: last.id })
        : null,
  };
}
