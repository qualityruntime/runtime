// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prefixed identifiers: `usr_v1stgxr8z5jdhi6b`.
 *
 * The prefix identifies the record type, so an identifier is self-describing in
 * a log line or an export. `schema/auth.ts` enforces the format with a CHECK
 * per table, rejecting inserts with the wrong prefix, alphabet, or length.
 *
 * Reasoning: `docs/adr/0002-prefixed-identifiers.md`.
 */

import { customAlphabet } from "nanoid";

/**
 * Lowercase base36: Nano ID's default URL-safe alphabet without `-`, `_`, and
 * case. Dropping `_` keeps the first underscore the prefix separator; dropping
 * case means nothing downstream can lose a row by normalizing one.
 */
const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * The prefix and random length each table's identifiers carry.
 *
 * Length follows what an identifier does, not how many rows a table holds: 16
 * for an ordinary row identifier (~83 bits), 24 where the identifier itself
 * participates in a possession-based flow. A row identifier is never a
 * credential — `session.token` authenticates a session, `verification.value`
 * proves a verification — so widening those would harden nothing.
 *
 * Keys name the record type. The auth types below happen to match Better Auth's
 * model names, which `generateId` relies on; domain types join the same list.
 * Every record type using this scheme needs an entry; `generateId` throws
 * without one.
 */
export const idFormats = {
  /**
   * The one exception: Better Auth takes an invitation by id in `accept`,
   * `reject`, and `get`, and gates those on a verified email whenever ids are
   * not its own opaque ones. Entropy keeps that gate from being the only defence.
   */
  invitation: { prefix: "inv", length: 24 },
  user: { prefix: "usr", length: 16 },
  session: { prefix: "ses", length: 16 },
  account: { prefix: "acc", length: 16 },
  verification: { prefix: "ver", length: 16 },
  organization: { prefix: "org", length: 16 },
  member: { prefix: "mem", length: 16 },
  twoFactor: { prefix: "tfa", length: 16 },
} as const;

export type IdType = keyof typeof idFormats;

/** One generator per type; Nano ID fixes the length at construction. */
const randomId = Object.fromEntries(
  Object.entries(idFormats).map(([model, { length }]) => [model, customAlphabet(alphabet, length)]),
) as Record<IdType, () => string>;

/** Generates an identifier for `type`, e.g. `createId("user")` → `usr_…`. */
export function createId(type: IdType): string {
  return `${idFormats[type].prefix}_${randomId[type]()}`;
}

/** The POSIX regular expression an identifier for `type` must match. */
export function idPattern(type: IdType): string {
  const { prefix, length } = idFormats[type];
  return `^${prefix}_[0-9a-z]{${length}}$`;
}

/**
 * Better Auth's `advanced.database.generateId`, so it writes these identifiers
 * instead of its own:
 *
 * ```ts
 * betterAuth({ advanced: { database: { generateId } } });
 * ```
 *
 * Throws on a model without a format — a table was added without being given
 * one, which the schema test catches before a deployment can.
 */
export function generateId({ model }: { model: string }): string {
  if (!(model in idFormats)) {
    throw new Error(`No identifier format is defined for the "${model}" table.`);
  }
  return createId(model as IdType);
}
