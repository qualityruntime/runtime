// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controls: tenant-owned measures with a one-way lifecycle.
 *
 * What a control is, which fields are deliberately absent, and what each
 * lifecycle status means are in `docs/data-model.md`. This file records how
 * that model is enforced.
 */

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { createdAt, id, idFormat, updatedAt } from "./columns.ts";

/**
 * The lifecycle a control may be in: `draft → active → retired`, one way
 * (`docs/data-model.md` gives each its meaning). The API answers for the moves
 * with errors a caller can act on; the database makes them one way — a draft
 * is exactly a control that never took effect, and a retired one stays
 * retired.
 */
export const controlStatuses = ["draft", "active", "retired"] as const;

export type ControlStatus = (typeof controlStatuses)[number];

/** Rendered into DDL, so `sql.raw`; the values are compile-time literals. */
const statusValues = controlStatuses.map((status) => `'${status}'`).join(", ");

export const control = pgTable(
  "control",
  {
    id: id("control"),
    /**
     * Which tenant owns the row (TENANT-01) — ownership, not permission: a
     * request still has to prove membership. Cascading keeps a deleted
     * organization from leaving rows no one can reach or authorize.
     *
     * A row-level security policy compares this to the organization
     * `withOrganization` sets, so reaching this table outside one sees nothing;
     * `migrations/0001_tenancy_and_finality.sql` has it.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * A CHECK rather than a PostgreSQL enum: the list will change while the
     * product is young, and dropping a CHECK is a plain migration where
     * removing or renaming an enum value is not.
     */
    status: text("status").$type<ControlStatus>().default("draft").notNull(),
    /**
     * When this record first became `active` in Quality Runtime, or null if it
     * never has. Not a real-world effective date: a control that has operated
     * for years is stamped when it is first activated here.
     *
     * Set and held by a trigger rather than by the application, so it cannot
     * be backdated, forged or cleared: a policy cannot compare a row to what
     * it used to be. `migrations/0001_tenancy_and_finality.sql` has it
     * (ADR 0017).
     */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("control", "control"),
    check("control_status_valid", sql.raw(`"status" in (${statusValues})`)),
    // A draft is exactly a control that never took effect. With the stamp
    // held by the trigger, this makes the lifecycle one way: an active or
    // retired control keeps its stamp, so it can never be a draft again, and
    // nothing is created active-and-unstamped or retired. The DELETE policy
    // can then read the status and mean what it says.
    check(
      "control_took_effect_unless_draft",
      sql`(${table.status} = 'draft') = (${table.activatedAt} is null)`,
    ),
    // A control no one can name is a data-entry accident, not a draft. The
    // predicate asks for one non-whitespace character rather than trimming:
    // PostgreSQL's one-argument `btrim` strips spaces only, so a name of tabs
    // or newlines would pass.
    check("control_name_present", sql`${table.name} ~ '[^[:space:]]'`),
    // Target for tenant-scoped references from mappings and evidence. The id
    // alone is unique, but PostgreSQL needs uniqueness on the referenced pair
    // too (ADR 0008).
    unique("control_id_organization_id_key").on(table.id, table.organizationId),
    // Every read is scoped to one tenant and ordered newest first, so the
    // ordering key belongs in the index: it serves the cursor comparison and
    // the sort together (ADR 0006). Its leading column still serves the
    // cascade when an organization is deleted.
    index("control_organization_id_created_at_id_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);
