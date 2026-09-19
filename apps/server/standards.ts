// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standard routes.
 *
 * A standard arrives whole. Nobody enters ISO 9001 one clause at a time, so the
 * only way to create one here is to import it with its requirements in a single
 * request and a single transaction — reasoning in
 * `docs/adr/0009-importing-a-standard.md`.
 *
 * Mounted under `/api/v1/organizations/:organizationId` behind
 * `organizationContext`, like controls; row-level security scopes every query
 * (ADR 0003), so nothing here filters by organization itself.
 */

import { idPattern, schema } from "@qualityruntime/db";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { fieldsOf } from "./audit.ts";
import type { OrganizationEnv } from "./organization.ts";
import {
  asStated,
  collectionQuery,
  type Ordering,
  cursorAt,
  newestFirst,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { failure } from "./responses.ts";
import { jsonBody, prose, queryParams, rejection, words } from "./validation.ts";

/**
 * How many clauses one import may carry.
 *
 * Bounds the rows inserted in one transaction, independently of the request
 * body limit in `app.ts`: a small body can contain many short clauses.
 */
const maxRequirements = 2_000;

// Strict, so a misspelt `text` is refused rather than imported as no text.
export const importBody = z.strictObject({
  name: words(200),
  edition: words(100),
  /**
   * In the order the standard states them. `position` is assigned from this
   * order rather than sent, because a client that has the clauses in order
   * already knows it, and one that does not would be guessing.
   */
  requirements: z
    .array(
      z.strictObject({
        reference: words(100),
        title: words(500),
        text: prose(50_000).nullish(),
      }),
    )
    .min(1)
    .max(maxRequirements)
    // A standard does not state the same clause twice, and the database says so
    // too — but reaching it would be a 500 for what is plainly malformed input.
    // Checked after trimming, because `1` and ` 1 ` are the same reference.
    .refine((rows) => new Set(rows.map((row) => row.reference)).size === rows.length, {
      message: "Two requirements share a reference.",
    })
    .meta({ description: "In the order the standard states them; references must be distinct." }),
});

export const standardResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  edition: z.string(),
  requirementCount: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Whether any control is mapped to the requirement.
 *
 * `mapped`, not `covered`: a link says a control is meant to address a
 * requirement, and whether that amounts to coverage is a judgement nothing here
 * makes (ADR 0010). What this answers is the narrower, checkable question —
 * which clauses of a standard nobody has taken up at all.
 */
const hasAControl = (mapped: boolean) => {
  const link = sql`select 1 from "control_requirement"
    where "control_requirement"."requirement_id" = "requirement"."id"`;
  return mapped ? sql`exists (${link})` : sql`not exists (${link})`;
};

/** The collection query, plus the filters a standard's requirements take. */
export const requirementsQuery = (ordering: Ordering) =>
  collectionQuery(ordering).extend({
    /**
     * Resolves a clause as people cite it — `7.5.3` in a commit message — to
     * the requirement it names, without reading the whole standard. Exact,
     * because a reference's identity is its exact string (ADR 0008).
     */
    reference: words(100)
      .meta({
        description:
          "Keep only the requirement with exactly this reference, after surrounding whitespace " +
          "is removed. References are unique within a standard, so a page holds one or none.",
      })
      .optional(),
    mapped: z
      .enum(["true", "false"])
      .meta({
        description:
          "Keep only requirements with a mapped control, or only those with none. Draft, active, " +
          "and retired controls all count. A mapping is not by itself a claim of coverage.",
      })
      .transform((value) => value === "true")
      .optional(),
  });

/** A standard is a record of what the organization imported, and when. */
export const standardOrder = newestFirst(
  "standards",
  schema.standard.createdAt,
  schema.standard.id,
);

/**
 * Its requirements are a document, read in the order the document states.
 *
 * Scoped to the standard, not just to the collection: every standard numbers its
 * clauses from one, so a cursor from another standard would be accepted on this
 * one and resume from a position that means something else entirely.
 */
export const requirementOrder = (standardId: string) =>
  asStated(`requirements/${standardId}`, schema.requirement.position, schema.requirement.id);

const isStandardId = new RegExp(idPattern("standard"));

/** Stops an id that could not name a standard before it reaches PostgreSQL. */
const knownStandardId = createMiddleware(async (c, next) => {
  if (!isStandardId.test(c.req.param("standardId") ?? "")) {
    return c.json(failure("not_found", "No such standard."), 404);
  }
  await next();
});

/**
 * How many requirements the standard states.
 *
 * A subquery rather than a stored counter: it cannot disagree with the rows,
 * and the index on `(organization_id, standard_id, position, id)` serves it.
 *
 * The column names are written out rather than interpolated. Drizzle renders a
 * single-table selection unqualified, which would turn the correlation into
 * `"standard_id" = "id"` — both resolving to the subquery's own table, and a
 * count of zero every time.
 */
const requirementCount = sql<number>`(
  select count(*)::int from "requirement"
  where "requirement"."standard_id" = "standard"."id"
)`;

/** What audit history records about a standard. */
const audited = ["name", "edition"] as const;

export const standards = new Hono<OrganizationEnv>()
  .get("/standards", queryParams(collectionQuery(standardOrder)), async (c) => {
    const { limit, cursor } = c.req.valid("query");

    const found = await c.var.withOrganization((tx) =>
      tx
        .select({
          ...getTableColumns(schema.standard),
          requirementCount,
          cursorAt: cursorAt(standardOrder),
        })
        .from(schema.standard)
        .where(cursor ? rowsAfter(standardOrder, cursor) : undefined)
        .orderBy(...orderedBy(standardOrder))
        .limit(limit + 1),
    );

    const { rows, nextCursor } = page(found, limit, standardOrder);
    return c.json({ data: rows, nextCursor });
  })

  .post("/standards", jsonBody(importBody), async (c) => {
    const body = c.req.valid("json");

    const result = await c.var.withOrganization(async (tx) => {
      const [created] = await tx
        .insert(schema.standard)
        .values({
          organizationId: c.var.member.organizationId,
          name: body.name,
          edition: body.edition,
        })
        .returning()
        .onConflictDoNothing({
          target: [schema.standard.organizationId, schema.standard.name, schema.standard.edition],
        });
      // The unique constraint on (organization, name, edition) decided this,
      // not a look-up beforehand that two imports could both pass.
      if (!created) return { outcome: "duplicate" } as const;

      await tx.insert(schema.requirement).values(
        body.requirements.map((requirement, index) => ({
          organizationId: created.organizationId,
          standardId: created.id,
          reference: requirement.reference,
          title: requirement.title,
          text: requirement.text ?? null,
          // The order they were sent in, one-based so it reads like a document.
          position: index + 1,
        })),
      );

      // One event for the import, not one per clause: what happened is that a
      // standard was imported (ADR 0009).
      await c.var.audit(tx, {
        action: "created",
        resourceType: "standard",
        resourceId: created.id,
        after: { ...fieldsOf(created, audited), requirementCount: body.requirements.length },
      });

      return {
        outcome: "imported",
        row: { ...created, requirementCount: body.requirements.length },
      } as const;
    });

    if (result.outcome === "duplicate") {
      return c.json(
        failure("already_exists", "That edition of that standard is already here.", [
          {
            path: "",
            message:
              "That name and edition are already imported, and cannot be imported again or merged.",
          },
        ]),
        409,
      );
    }
    return c.json({ data: result.row }, 201);
  })

  .get("/standards/:standardId", knownStandardId, async (c) => {
    const [row] = await c.var.withOrganization((tx) =>
      tx
        .select({
          ...getTableColumns(schema.standard),
          requirementCount,
        })
        .from(schema.standard)
        .where(eq(schema.standard.id, c.req.param("standardId"))),
    );
    if (!row) return c.json(failure("not_found", "No such standard."), 404);

    return c.json({ data: row });
  })

  .get("/standards/:standardId/requirements", knownStandardId, async (c) => {
    const standardId = c.req.param("standardId");
    // Parsed here rather than by middleware: the schema depends on which
    // standard is being read, which only this handler knows.
    const ordering = requirementOrder(standardId);
    const query = requirementsQuery(ordering).safeParse(c.req.query());
    if (!query.success) return c.json(rejection("query", query.error), 400);
    const { limit, cursor, mapped, reference } = query.data;

    // One snapshot: under `read committed` the check and the page are two
    // statements, and a parent deleted between them would read as an empty one.
    const found = await c.var.withOrganization(
      async (tx) => {
        // The standard has to be visible first, or its absence would read as a
        // standard with no requirements.
        const [standard] = await tx
          .select({ id: schema.standard.id })
          .from(schema.standard)
          .where(eq(schema.standard.id, standardId));
        if (!standard) return undefined;

        return tx
          .select({ ...getTableColumns(schema.requirement), cursorAt: cursorAt(ordering) })
          .from(schema.requirement)
          .where(
            and(
              eq(schema.requirement.standardId, standardId),
              cursor ? rowsAfter(ordering, cursor) : undefined,
              mapped === undefined ? undefined : hasAControl(mapped),
              reference === undefined ? undefined : eq(schema.requirement.reference, reference),
            ),
          )
          .orderBy(...orderedBy(ordering))
          .limit(limit + 1);
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such standard."), 404);

    const { rows, nextCursor } = page(found, limit, ordering);
    return c.json({ data: rows, nextCursor });
  });
