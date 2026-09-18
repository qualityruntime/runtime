// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standards and the requirements they state.
 *
 * What a standard is, why an edition is part of its identity, and why every
 * organization holds its own copy are in `docs/data-model.md`; the reasoning is
 * in `docs/adr/0008-standards-and-requirements.md`. This file records how the
 * model is enforced.
 */

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { createdAt, id, idFormat, updatedAt } from "./columns.ts";

/** Rejects a value that is blank or only whitespace, the way `control` does. */
const present = (table: string, column: string) =>
  check(`${table}_${column}_present`, sql.raw(`"${column}" ~ '[^[:space:]]'`));

export const standard = pgTable(
  "standard",
  {
    id: id("standard"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** What it is called: `ISO 9001`, `SOC 2`, `Information security policy`. */
    name: text("name").notNull(),
    /**
     * Which issue of it. Part of the identity, not a detail: ISO 9001:2015 and
     * its successor state different requirements, and a record of conformity
     * means nothing without saying to what.
     */
    edition: text("edition").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("standard", "standard"),
    present("standard", "name"),
    present("standard", "edition"),
    // One row per issue of a standard. Holding ISO 9001:2015 twice is a
    // duplicate to reconcile, not two things.
    uniqueIndex("standard_organization_id_name_edition_uidx").on(
      table.organizationId,
      table.name,
      table.edition,
    ),
    // The target of `requirement`'s composite foreign key needs uniqueness on
    // the pair, even though id alone is unique. A suitable unique index would
    // also work, but this constraint is created with the table, before the
    // generated migration adds foreign keys and then standalone indexes.
    unique("standard_id_organization_id_key").on(table.id, table.organizationId),
    index("standard_organization_id_created_at_id_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const requirement = pgTable(
  "requirement",
  {
    id: id("requirement"),
    /**
     * Carried rather than reached through `standard`, so one policy shape fits
     * every tenant-owned table (ADR 0003). The composite foreign key below is
     * what keeps it honest.
     */
    organizationId: text("organization_id").notNull(),
    standardId: text("standard_id").notNull(),
    /**
     * How the standard itself refers to this requirement — `7.5.3`, `A.5.1`,
     * `CC6.1`. Not an identifier this system generates, and not unique beyond
     * the standard that uses it.
     */
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    /**
     * The requirement as stated.
     *
     * Nullable on purpose: the text of a published standard is usually
     * copyrighted, and a deployment may hold a licence to read it without a
     * right to store or redistribute it. A requirement is still worth tracking
     * by reference and title alone.
     */
    text: text("text"),
    /**
     * Where it falls in the standard's own order. Clause references do not sort
     * — `7.10` precedes `7.9` lexically — and rendering a standard out of order
     * is rendering a different document.
     *
     * Not unique within a standard, deliberately: inserting a clause between
     * two others, or swapping a pair, would otherwise need every row after it
     * renumbered in the same statement. Ties are therefore possible, so the
     * order is `(position, id)` and never `position` alone.
     */
    position: integer("position").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("requirement", "requirement"),
    present("requirement", "reference"),
    present("requirement", "title"),
    /**
     * The tenant boundary and the parent in one constraint. Referencing
     * `(id, organization_id)` rather than `id` alone makes a requirement
     * belonging to one organization and a standard belonging to another
     * impossible to write, rather than merely wrong (TENANT-01).
     */
    foreignKey({
      name: "requirement_standard_fk",
      columns: [table.standardId, table.organizationId],
      foreignColumns: [standard.id, standard.organizationId],
    }).onDelete("cascade"),
    // What `control_requirement` references; see `standard` above.
    unique("requirement_id_organization_id_key").on(table.id, table.organizationId),
    // A standard does not state the same clause twice.
    uniqueIndex("requirement_standard_id_reference_uidx").on(table.standardId, table.reference),
    // A standard's requirements, in the order the standard states them. The
    // identifier is part of the key because positions may tie, and an order
    // that is not total cannot be paged (ADR 0006).
    index("requirement_organization_id_standard_id_position_id_idx").on(
      table.organizationId,
      table.standardId,
      table.position,
      table.id,
    ),
  ],
);
