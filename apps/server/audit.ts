// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Recording what changed (AUDIT-01).
 *
 * `organizationContext` binds `recordChange` to the caller and organization as
 * `c.var.audit`, so a handler chooses what happened but never who did it.
 * Reasoning: `docs/adr/0005-audit-history.md`.
 */

import { schema, type TenantTransaction } from "@qualityruntime/db";

type AuditFields = schema.AuditFields;

/**
 * The record types audit history can refer to. Extended as entities arrive.
 *
 * A list rather than a union, because `history.ts` needs to iterate it to work
 * out which record an identifier names. One source, so a new entity cannot be
 * recordable and unreadable.
 */
export const resourceTypes = ["control", "standard"] as const;

export type ResourceType = (typeof resourceTypes)[number];

type Records = { resourceType: ResourceType; resourceId: string };

/**
 * What happened to a record, and what it looked like either side of it.
 *
 * A union rather than two optional fields, so the shape states the rule instead
 * of merely permitting it: a creation has nothing before it and a deletion
 * nothing after. Two optional fields would let a creation carry a `before` and
 * a deletion an `after`, and nothing would object.
 *
 * `updated` keeps `before` optional because not every change is a replacement:
 * one that only adds something has no previous value to name.
 */
export type Change = Records &
  (
    | { action: "created"; before?: never; after: AuditFields }
    | { action: "deleted"; before: AuditFields; after?: never }
    | { action: "updated"; before?: AuditFields; after: AuditFields }
  );

/** Who the change is attributed to, resolved once per request. */
export type Actor = {
  type: (typeof schema.actorTypes)[number];
  id: string;
  /** How the actor was named at the time; see `schema/audit.ts`. */
  label: string | null;
  /**
   * Whose account the actor was working through, when that is someone else —
   * an administrator impersonating a member. The administrator is the actor,
   * because they are the one accountable for what happened.
   */
  onBehalfOf?: { id: string; label: string | null };
};

/** Records a change on the transaction that makes it. */
export type RecordChange = (tx: TenantTransaction, change: Change) => Promise<void>;

/**
 * Writes the audit row for `change`.
 *
 * Takes the transaction rather than a handle of its own, because history that
 * can commit without the change it describes — or the other way round — is
 * worse than none. Both live or neither does.
 */
export function recordChange(
  tx: TenantTransaction,
  actor: Actor,
  organizationId: string,
  change: Change,
): Promise<void> {
  return tx
    .insert(schema.auditEvent)
    .values({
      organizationId,
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      onBehalfOfId: actor.onBehalfOf?.id ?? null,
      onBehalfOfLabel: actor.onBehalfOf?.label ?? null,
      action: change.action,
      resourceType: change.resourceType,
      resourceId: change.resourceId,
      before: change.before ?? null,
      after: change.after,
    })
    .then(() => undefined);
}

/**
 * The fields of `row` that `only` names, as they stand.
 *
 * Callers select domain fields, including timestamps describing domain events.
 * Record identity is stored separately; bookkeeping timestamps (`created_at`,
 * `updated_at`) describe the write and are omitted by the caller.
 */
export function fieldsOf<T extends object, K extends keyof T>(row: T, only: readonly K[]) {
  return Object.fromEntries(only.map((field) => [field, row[field]])) as Pick<T, K>;
}

/**
 * Whether two field values are the same.
 *
 * Two `Date`s for one instant are different objects, so `!==` would report a
 * change on every update that touched a timestamp; and coercing both to strings
 * instead would lose milliseconds, and make `null` and the string `"null"` the
 * same value.
 */
const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

/**
 * The subset of `after` that differs from `before`, on both sides.
 *
 * Returns `undefined` when nothing changed: a request that asked for the values
 * a record already had is not an event, and recording it would bury the ones
 * that are.
 */
export function diffFields<T extends object>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> } | undefined {
  const changed = (Object.keys(after) as (keyof T)[]).filter(
    (key) => !same(before[key], after[key]),
  );
  if (changed.length === 0) return undefined;

  return {
    before: Object.fromEntries(changed.map((key) => [key, before[key]])) as Partial<T>,
    after: Object.fromEntries(changed.map((key) => [key, after[key]])) as Partial<T>,
  };
}
