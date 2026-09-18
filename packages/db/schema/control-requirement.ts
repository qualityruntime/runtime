// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which controls answer to which requirements.
 *
 * The join that gives a control a reason and a requirement something answering
 * to it. Whether that amounts to coverage is a judgement this table does not
 * make: a link says a control is meant to address a requirement, nothing more.
 * Reasoning: `docs/adr/0010-mapping-controls-to-requirements.md`.
 */

import { foreignKey, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.ts";
import { control } from "./control.ts";
import { requirement } from "./standard.ts";

export const controlRequirement = pgTable(
  "control_requirement",
  {
    /**
     * Carried once and shared by both references below, so a control and a
     * requirement from different organizations cannot be joined (TENANT-01).
     * Those references are what tie it to the organization; one of its own
     * would add nothing.
     */
    organizationId: text("organization_id").notNull(),
    controlId: text("control_id").notNull(),
    requirementId: text("requirement_id").notNull(),
    /** When the mapping was made. A link is never updated; no policy allows it. */
    createdAt: createdAt(),
  },
  (table) => [
    /**
     * No surrogate identifier: the pair is the identity, and a second row for
     * the same pair would say nothing the first does not. `schema/index.test.ts`
     * exempts a join table keyed this way (ADR 0002).
     */
    primaryKey({ columns: [table.controlId, table.requirementId] }),
    /**
     * Both references are composite, and both borrow the same
     * `organization_id`: a row can only exist if the control and the
     * requirement it names are in that one organization (ADR 0008).
     */
    foreignKey({
      name: "control_requirement_control_fk",
      columns: [table.controlId, table.organizationId],
      foreignColumns: [control.id, control.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "control_requirement_requirement_fk",
      columns: [table.requirementId, table.organizationId],
      foreignColumns: [requirement.id, requirement.organizationId],
    }).onDelete("cascade"),
    // The other direction — which controls are mapped to a requirement — and the
    // organization leads it so the policy and the cascade both use it.
    index("control_requirement_organization_id_requirement_id_idx").on(
      table.organizationId,
      table.requirementId,
      table.controlId,
    ),
  ],
);
