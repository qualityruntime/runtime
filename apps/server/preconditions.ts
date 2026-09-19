// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Conditional writes: `If-Match`, and the row version it quotes.
 *
 * Two people editing one record is otherwise last-writer-wins, and the loser
 * never learns. A caller that read a record can name the version it read and be
 * refused if it has moved since (ADR 0019). Optional: a caller that does not
 * ask gets the write regardless.
 */

import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * A row's version, as text.
 *
 * `xmin` identifies the transaction that wrote the row version. Updates in
 * separate transactions receive different values until transaction IDs wrap;
 * repeated updates within one transaction share a value. `updated_at` has only
 * JavaScript's millisecond precision, so separate writes can share a timestamp.
 *
 * A dump and restore can change `xmin`, so tags are not durable across a
 * restore. VACUUM FREEZE preserves the reported value (ADR 0019).
 */
export const rowVersion = (table: PgTable): SQL<string> => sql<string>`${table}."xmin"::text`;

/** The entity tag for a row read with `rowVersion`. */
export const entityTag = (row: { version: string }) => `"${row.version}"`;

/**
 * A version for a *set* of rows, which has no `xmin` of its own.
 *
 * Replacing a control's requirements replaces mapping rows, so no single row
 * version describes the set. Hash the member identifiers instead (ADR 0019):
 * the same members give the same tag regardless of their input order.
 *
 * It says nothing about *when* — two sets that are equal are indistinguishable,
 * which is what a caller asking "is it still what I read?" actually means.
 */
export const setVersion = (members: readonly string[]): string =>
  // JSON rather than a join, so no member can pass for two.
  createHash("sha256")
    .update(JSON.stringify([...new Set(members)].sort()))
    .digest("hex");

/** What `If-Match` said about the row as it now stands. */
export type Precondition = "absent" | "met" | "failed";

/**
 * Every entity tag in an `If-Match`, or null if the field is not one.
 *
 * A tag is opaque and quoted, and a comma or an asterisk inside the quotes is
 * part of it — so the field cannot be split on commas. `"a,*,b"` is one tag
 * that matches nothing, and splitting it would expose an `*` that was never a
 * wildcard and let any write through (RFC 9110 §8.8.3).
 */
function entityTags(field: string): string[] | null {
  // `etagc` (RFC 9110 §8.8.3): visible ASCII but the quote, or obs-text. A
  // space or a control character inside the quotes makes it not a tag.
  const tag = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/y;
  const tags: string[] = [];
  let at = 0;
  const skip = (pattern: RegExp) => {
    pattern.lastIndex = at;
    if (pattern.exec(field)) at = pattern.lastIndex;
  };

  // Empty elements are ignored wherever they appear, leading ones included:
  // RFC 9110 §5.6.1 asks recipients to tolerate them rather than refuse.
  skip(/[ \t,]*/y);
  while (at < field.length) {
    tag.lastIndex = at;
    const found = tag.exec(field);
    if (!found) return null;
    tags.push(found[0]);
    at = tag.lastIndex;
    skip(/[ \t]*/y);
    if (at >= field.length) break;
    if (field[at] !== ",") return null;
    at += 1;
    skip(/[ \t,]*/y);
  }
  return tags;
}

/**
 * Whether a write may proceed, given the caller's `If-Match`.
 *
 * `absent` is not a failure: a client that does not ask for the guarantee gets
 * the old behaviour rather than an error, which is what keeps a simple client
 * simple. A route that needs the guarantee refuses `absent` itself.
 *
 * `*` matches any existing row, which is how a caller says "only if it is still
 * there" — and only when it is the whole field, never one item of a list.
 * Comparison is strong, per RFC 9110: a weak tag (`W/"…"`) never matches, and
 * nothing here issues one. Anything that is not a well-formed field fails,
 * because a client that sent the header meant something by it.
 */
export function ifMatch(header: string | undefined, tag: string): Precondition {
  if (header === undefined) return "absent";
  // Only SP and HTAB surround it (RFC 9110 OWS); `trim` would also accept
  // Unicode spaces a client never meant as a wildcard.
  if (/^[ \t]*\*[ \t]*$/.test(header)) return "met";
  const offered = entityTags(header);
  return offered?.includes(tag) ? "met" : "failed";
}

/**
 * The row as a client sees it: everything but the version.
 *
 * The version is read alongside the columns so that one query serves both the
 * body and the tag. Response-schema tests reject the extra field; handlers
 * do not validate outgoing responses at runtime.
 */
export const withoutVersion = <T extends { version: string }>(row: T): Omit<T, "version"> => {
  const { version, ...rest } = row;
  void version;
  return rest;
};
