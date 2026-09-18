// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit history: who changed what, when (AUDIT-01).
 *
 * The model and its rules are in `docs/data-model.md`; the reasoning is in
 * `docs/adr/0005-audit-history.md`. This file records how it is enforced.
 */

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { idPattern } from "../id.ts";
import { id, idFormat } from "./columns.ts";

/** A user's identifier, shaped as one. Rendered into DDL, so a literal. */
const userId = idPattern("user");

/**
 * What kind of thing made the change.
 *
 * Only `user` is written today. `system` is reserved for background work
 * because the history API publishes this enum: adding a value later affects
 * clients that switch on it, even though widening the CHECK is straightforward.
 */
export const actorTypes = ["user", "system"] as const;

export type ActorType = (typeof actorTypes)[number];

/** Rendered into DDL, so `sql.raw`; the values are compile-time literals. */
const actorTypeValues = actorTypes.map((type) => `'${type}'`).join(", ");

/** Record fields as they stood, excluding identity and bookkeeping timestamps. */
export type AuditFields = Record<string, unknown>;

export const auditEvent = pgTable(
  "audit_event",
  {
    id: id("auditEvent"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Who acted. `actorId` is not a foreign key: `user` rows are deletable, and
     * history that vanishes with the actor is not history (AUDIT-01). The
     * CHECK below asks only that it be shaped like a user's identifier — a
     * user since deleted still attributes, by design.
     * `actorLabel` is how they were named at the time, kept because an
     * identifier alone tells a later reader nothing once the row is gone.
     */
    actorType: text("actor_type").$type<ActorType>().notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"),
    /**
     * Who the actor was acting as, when that is someone else. An administrator
     * impersonating a member is still the one accountable for what happened, so
     * they are the actor; this says whose account it happened through. Null for
     * the ordinary case.
     */
    onBehalfOfId: text("on_behalf_of_id"),
    onBehalfOfLabel: text("on_behalf_of_label"),
    /** What happened, as a verb: `created`, `updated`. */
    action: text("action").notNull(),
    /** Which record it happened to. Not a foreign key, for the same reason. */
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    /**
     * The fields that changed, and nothing else — `before` is null for a
     * creation and `after` for a deletion. Record identity, bookkeeping
     * timestamps (`created_at`, `updated_at`), and unchanged fields are left
     * out. Domain timestamps, such as when evidence occurred or was attested,
     * belong here.
     */
    before: jsonb("before").$type<AuditFields>(),
    after: jsonb("after").$type<AuditFields>(),
    /**
     * When the change happened.
     *
     * `clock_timestamp()` rather than `now()`, which is the transaction's start
     * time: two requests changing the same record serialize on its row lock, so
     * the one that starts first can commit second, and transaction-start order
     * would put its history the wrong way round. There is no `updated_at` —
     * these rows never change.
     */
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    idFormat("audit_event", "auditEvent"),
    check("audit_event_actor_type_valid", sql.raw(`"actor_type" in (${actorTypeValues})`)),
    // A user acted or the system did; either way the row says which. A user
    // is named by a user's identifier, not merely something present: the row
    // can never be corrected. The system has no identity yet, so it carries
    // none — whatever one is invented gets its own shape here. Labels stay
    // optional: a name is not always known, an identifier is.
    //
    // The `is not null` is load-bearing: a CHECK holds when its expression is
    // NULL, and a pattern match against NULL is NULL rather than false.
    check(
      "audit_event_actor_is_identified",
      sql.raw(
        `("actor_type" = 'user' and "actor_id" is not null and "actor_id" ~ '${userId}') ` +
          `or ("actor_type" = 'system' and "actor_id" is null)`,
      ),
    ),
    // Somebody's account, or nobody's: a label describing nobody is not
    // attribution either.
    check(
      "audit_event_on_behalf_of_is_identified",
      sql.raw(
        `("on_behalf_of_id" is not null and "on_behalf_of_id" ~ '${userId}') ` +
          `or ("on_behalf_of_id" is null and "on_behalf_of_label" is null)`,
      ),
    ),
    // What happened, and to what. Only shape: an append-only row that is
    // blank here stays blank forever.
    check("audit_event_action_present", sql`${table.action} ~ '[^[:space:]]'`),
    check("audit_event_resource_type_present", sql`${table.resourceType} ~ '[^[:space:]]'`),
    check("audit_event_resource_id_present", sql`${table.resourceId} ~ '[^[:space:]]'`),
    // Fields by name, as `AuditFields` says — never a bare value or a list,
    // which a writer bug would otherwise leave in the history for good.
    check(
      "audit_event_before_is_object",
      sql`${table.before} is null or jsonb_typeof(${table.before}) = 'object'`,
    ),
    check(
      "audit_event_after_is_object",
      sql`${table.after} is null or jsonb_typeof(${table.after}) = 'object'`,
    ),
    // The history of one record, in the order it is read: the ordering key
    // extends the lookup so a page is an index scan rather than a sort of
    // everything that matched (ADR 0006). The leading column still serves the
    // cascade when an organization is deleted.
    index("audit_event_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
      table.id,
    ),
    // An organization's whole history, in the order it is read. The index
    // above cannot serve this: `resource_id` sits between the type and the
    // ordering key, so a page of everything would be a sort of everything
    // (ADR 0006).
    index("audit_event_organization_id_created_at_id_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);
