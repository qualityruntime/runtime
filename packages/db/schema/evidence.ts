// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence: a record that a control was actually operated.
 *
 * The first finalised record here. What attestation means, and why an attested
 * row cannot be changed by the application at all, is in
 * `docs/adr/0012-evidence-and-attestation.md`.
 */

import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { idPattern } from "../id.ts";
import { createdAt, id, idFormat, updatedAt } from "./columns.ts";
import { control } from "./control.ts";

export const evidence = pgTable(
  "evidence",
  {
    id: id("evidence"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    controlId: text("control_id").notNull(),
    /** What it is: `Q3 access review minutes`, `Restore test of 12 March`. */
    title: text("title").notNull(),
    description: text("description"),
    /**
     * When the thing this evidences happened — not when the row was written.
     * Evidence of a review done last quarter is evidence about last quarter,
     * whenever someone got round to recording it. The API refuses a future one:
     * nothing that has not happened is evidence that it did.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /**
     * Who vouched for it, and when. Null until someone does.
     *
     * `attestedById` is not a foreign key — the CHECK below asks only that it
     * be shaped like a user's identifier — and `attestedByLabel` keeps the name
     * as it stood, for the reason audit history does the same: a record of who
     * vouched for something is worth nothing if it disappears with them
     * (AUDIT-01).
     */
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    attestedById: text("attested_by_id"),
    attestedByLabel: text("attested_by_label"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("evidence", "evidence"),
    check("evidence_title_present", sql`${table.title} ~ '[^[:space:]]'`),
    // Attested means somebody attested. Either nothing is set, or there is a
    // time and a user's identifier behind it — a time with no one, a name
    // with no time, and a malformed identifier are all half an attestation.
    // The `is not null` is not redundant: a CHECK holds when its expression is
    // NULL, and a comparison against NULL is NULL rather than false. The label
    // stays optional, as it is in audit history.
    check(
      "evidence_attestation_complete",
      sql.raw(`(
        "attested_at" is null
          and "attested_by_id" is null
          and "attested_by_label" is null
      ) or (
        "attested_at" is not null
          and "attested_by_id" is not null
          and "attested_by_id" ~ '${idPattern("user")}'
      )`),
    ),
    /**
     * The control it is evidence for, and the tenant boundary in one
     * constraint (ADR 0008).
     *
     * Restricting rather than cascading. A cascade is a referential action, so
     * it answers to neither row-level security nor table privileges: deleting
     * a control would take its attested evidence with it and leave no trace,
     * around the policy that makes an attestation final (ADR 0012). Evidence
     * has to be disposed of deliberately, and attested evidence cannot be.
     */
    foreignKey({
      name: "evidence_control_fk",
      columns: [table.controlId, table.organizationId],
      foreignColumns: [control.id, control.organizationId],
    }).onDelete("restrict"),
    // What `file` references, so an attachment names evidence in one
    // organization and nothing else. A constraint rather than a unique index so
    // that it is part of `CREATE TABLE`, and therefore already there when the
    // referencing table's foreign key is added (ADR 0008).
    unique("evidence_id_organization_id_key").on(table.id, table.organizationId),
    // A control's evidence, in the order the things it records happened.
    index("evidence_organization_id_control_id_occurred_at_id_idx").on(
      table.organizationId,
      table.controlId,
      table.occurredAt,
      table.id,
    ),
  ],
);
