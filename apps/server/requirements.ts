// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Requirement routes.
 *
 * A requirement belongs to a standard, but is not only reachable through one: a
 * control names requirements by identifier, and following that identifier
 * should not mean knowing which standard stated it. Reasoning:
 * `docs/adr/0011-reading-a-mapping-from-both-ends.md`.
 *
 * Mounted under `/api/v1/organizations/:organizationId` behind
 * `organizationContext`; row-level security scopes every query (ADR 0003).
 */

import { idPattern, schema } from "@qualityruntime/db";
import { and, eq, getTableColumns } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { OrganizationEnv } from "./organization.ts";
import {
  collectionQuery,
  cursorAt,
  newestFirst,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { failure } from "./responses.ts";
import { rejection } from "./validation.ts";

/** A requirement, as a client sees it. */
export const requirementResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  standardId: z.string(),
  reference: z.string(),
  title: z.string(),
  text: z.string().nullable(),
  position: z.int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * The controls answering to a requirement, newest first.
 *
 * Controls have no order of their own — nothing states them in a sequence the
 * way a standard states its clauses — so the ordering is the one every record
 * of what has happened gets. Scoped to the requirement, like every cursor.
 */
export const requirementControlsOrder = (requirementId: string) =>
  newestFirst(`requirement-controls/${requirementId}`, schema.control.createdAt, schema.control.id);

const isRequirementId = new RegExp(idPattern("requirement"));

/** Stops an id that could not name a requirement before it reaches PostgreSQL. */
const knownRequirementId = createMiddleware(async (c, next) => {
  if (!isRequirementId.test(c.req.param("requirementId") ?? "")) {
    return c.json(failure("not_found", "No such requirement."), 404);
  }
  await next();
});

export const requirements = new Hono<OrganizationEnv>()
  .get("/requirements/:requirementId", knownRequirementId, async (c) => {
    const [row] = await c.var.withOrganization((tx) =>
      tx
        .select()
        .from(schema.requirement)
        .where(eq(schema.requirement.id, c.req.param("requirementId"))),
    );
    if (!row) return c.json(failure("not_found", "No such requirement."), 404);

    return c.json({ data: row });
  })

  .get("/requirements/:requirementId/controls", knownRequirementId, async (c) => {
    const requirementId = c.req.param("requirementId");
    const ordering = requirementControlsOrder(requirementId);
    const query = collectionQuery(ordering).safeParse(c.req.query());
    if (!query.success) return c.json(rejection("query", query.error), 400);
    const { limit, cursor } = query.data;

    // One snapshot: under `read committed` the check and the page are two
    // statements, and a parent deleted between them would read as an empty one.
    const found = await c.var.withOrganization(
      async (tx) => {
        // The requirement has to be visible first, or its absence would read as a
        // requirement nothing answers to.
        const [requirement] = await tx
          .select({ id: schema.requirement.id })
          .from(schema.requirement)
          .where(eq(schema.requirement.id, requirementId));
        if (!requirement) return undefined;

        return tx
          .select({ ...getTableColumns(schema.control), cursorAt: cursorAt(ordering) })
          .from(schema.controlRequirement)
          .innerJoin(schema.control, eq(schema.control.id, schema.controlRequirement.controlId))
          .where(
            and(
              eq(schema.controlRequirement.requirementId, requirementId),
              cursor ? rowsAfter(ordering, cursor) : undefined,
            ),
          )
          .orderBy(...orderedBy(ordering))
          .limit(limit + 1);
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such requirement."), 404);

    const { rows, nextCursor } = page(found, limit, ordering);
    return c.json({ data: rows, nextCursor });
  });
