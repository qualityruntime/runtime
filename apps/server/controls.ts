// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Control routes.
 *
 * Mounted under `/api/v1/organizations/:organizationId`, behind
 * `organizationContext` — so by the time a handler runs, the caller is a member
 * and `c.var.withOrganization` is bound to their organization. Nothing here
 * filters by organization itself: row-level security does that (ADR 0003), and
 * a control belonging to another one is simply not there, which is why an
 * ordinary 404 is the right answer for it.
 */

import { idPattern, schema, type TenantTransaction } from "@qualityruntime/db";
import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { diffFields, fieldsOf } from "./audit.ts";
import { entityTag, ifMatch, rowVersion, setVersion, withoutVersion } from "./preconditions.ts";
import { failure } from "./responses.ts";
import type { OrganizationEnv } from "./organization.ts";
import {
  asStated,
  collectionQuery,
  cursorAt,
  newestFirst,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { jsonBody, prose, queryParams, rejection, words } from "./validation.ts";

type ControlStatus = (typeof schema.controlStatuses)[number];

/** Bounds the database does not impose: `text` accepts a megabyte as happily as a sentence. */
const name = words(200);
const description = prose(10_000);

/** A control is always created as a draft; `PATCH` is what moves it on. */
export const createBody = z.object({ name, description: description.nullish() });

export const updateBody = z
  .object({
    name: name.optional(),
    // Explicitly `null` clears it; absent leaves it alone.
    description: description.nullable().optional(),
    status: z.enum(schema.controlStatuses).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to change.",
  })
  // `refine` converts to nothing, so the same rule is stated again in a form
  // JSON Schema has. `minProperties` would not do: an unknown property counts
  // towards it, and the server drops those before finding nothing left to
  // change (ADR 0007).
  .meta({
    anyOf: [{ required: ["name"] }, { required: ["description"] }, { required: ["status"] }],
    description: "At least one of name, description or status.",
  });

/**
 * The status changes the lifecycle in `docs/data-model.md` allows: one way.
 *
 * A control in effect is withdrawn deliberately rather than quietly unpublished,
 * and a withdrawn one stays withdrawn — what replaces it is a new control, and
 * the retired one stays a distinct record of what was in effect. Setting
 * the status it already has is a no-op and always allowed. The database holds
 * the part that matters: nothing that took effect can be a draft again.
 */
const transitions: Record<ControlStatus, readonly ControlStatus[]> = {
  draft: ["active"],
  active: ["retired"],
  retired: [],
};

/** What audit history records about a control: its own fields, nothing else. */
const audited = ["name", "description", "status"] as const;

const version = rowVersion(schema.control);

/**
 * Every requirement a control is mapped to, in one stable order.
 *
 * Read whole rather than by the page: the page is a window on the set, and the
 * version has to be the set's (ADR 0019).
 */
const mappedTo = async (tx: TenantTransaction, controlId: string): Promise<string[]> => {
  const rows = await tx
    .select({ requirementId: schema.controlRequirement.requirementId })
    .from(schema.controlRequirement)
    .where(eq(schema.controlRequirement.controlId, controlId));
  return rows.map((row) => row.requirementId).sort();
};

/** The one answer for an `If-Match` that no longer names these requirements. */
const staleRequirements = (c: Context) =>
  c.json(
    failure("precondition_failed", "The control's requirements changed since they were read.", [
      { path: "", message: "Read them again, and decide against what they now are." },
    ]),
    412,
  );

/** The one answer for an `If-Match` that no longer names this control. */
const staleControl = (c: Context) =>
  c.json(
    failure("precondition_failed", "The control changed since it was read.", [
      { path: "", message: "Read it again, and decide against what it now says." },
    ]),
    412,
  );

const isControlId = new RegExp(idPattern("control"));

/**
 * The requirements of `ids` that are here, held against deletion until commit.
 *
 * Named rather than left to the foreign key, which reports a requirement in
 * another organization and one that does not exist the same way — as a 500.
 * Reading them is not enough on its own: under `read committed` another
 * transaction may delete one, or the standard stating it, between this and the
 * insert, and the foreign key would then raise. `for key share` is the lock
 * that says so — it blocks a delete without blocking anyone else reading the
 * same rows.
 */
const lockRequirements = async (tx: TenantTransaction, ids: string[]) =>
  ids.length === 0
    ? []
    : tx
        .select({ id: schema.requirement.id })
        .from(schema.requirement)
        .where(inArray(schema.requirement.id, ids))
        .for("key share");

/**
 * The requirements a control answers to, as a client sets them.
 *
 * A set, not a sequence: order carries no meaning, and a repeated identifier
 * says nothing the first did not.
 */
export const controlRequirementsBody = z.object({
  requirementIds: z
    .array(z.string().regex(new RegExp(idPattern("requirement"))))
    .max(500)
    .meta({
      description:
        "Replaces the whole set. At most 500 entries; a repeated identifier is ignored when " +
        "forming the set. An empty array clears it.",
    }),
});

/**
 * A control's requirements, in the order their standards state them.
 *
 * Requirements from different standards interleave, because a position is only
 * meaningful within its own standard. Each carries its `standardId`, which is
 * what a client groups by; ordering across standards is a decision to make when
 * something needs one.
 */
export const controlRequirementsOrder = (controlId: string) =>
  asStated(`control-requirements/${controlId}`, schema.requirement.position, schema.requirement.id);

/** Controls and their history are both records of what has happened. */
export const controlOrder = newestFirst("controls", schema.control.createdAt, schema.control.id);
/** A control response contract; tests reject undeclared fields. */
export const controlResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.enum(schema.controlStatuses),
  /**
   * When it first took effect, or null if it never has. Set by the database
   * and never changed, so it is part of the record: the status says where a
   * control is now, this says when it began to count (ADR 0017).
   */
  activatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** The requirements a control is mapped to, as a client sees them. */
export const controlRequirementsResponse = z.strictObject({
  requirementIds: z.array(z.string()),
});

/**
 * Stops an id that could not name a control before it reaches PostgreSQL.
 *
 * Mostly tidiness — one less pointless query — but it also keeps a path
 * segment carrying a NUL from failing the statement itself, which the driver
 * would report as a server error rather than the absence it actually is.
 */
const knownControlId = createMiddleware(async (c, next) => {
  if (!isControlId.test(c.req.param("controlId") ?? "")) {
    return c.json(failure("not_found", "No such control."), 404);
  }
  await next();
});

export const controls = new Hono<OrganizationEnv>()
  .get("/controls", queryParams(collectionQuery(controlOrder)), async (c) => {
    const { limit, cursor } = c.req.valid("query");

    const found = await c.var.withOrganization((tx) =>
      tx
        .select({ ...getTableColumns(schema.control), cursorAt: cursorAt(controlOrder) })
        .from(schema.control)
        .where(cursor ? rowsAfter(controlOrder, cursor) : undefined)
        // `created_at` defaults to `now()`, which is the transaction's start
        // time, so rows written together share it; the id breaks the tie and
        // makes the order — and so the cursor — total.
        .orderBy(...orderedBy(controlOrder))
        .limit(limit + 1),
    );

    const { rows, nextCursor } = page(found, limit, controlOrder);
    return c.json({ data: rows, nextCursor });
  })

  .post("/controls", jsonBody(createBody), async (c) => {
    const body = c.req.valid("json");

    const row = await c.var.withOrganization(async (tx) => {
      const [created] = await tx
        .insert(schema.control)
        .values({
          // The organization the caller was authorized for, never one from the
          // body. A mismatch would fail the policy's WITH CHECK anyway.
          organizationId: c.var.member.organizationId,
          name: body.name,
          description: body.description ?? null,
        })
        .returning();

      // Same transaction as the insert: history and the change it describes
      // commit together or not at all (ADR 0005).
      await c.var.audit(tx, {
        action: "created",
        resourceType: "control",
        resourceId: created!.id,
        after: fieldsOf(created!, audited),
      });
      return created;
    });

    return c.json({ data: row }, 201);
  })

  .get("/controls/:controlId", knownControlId, async (c) => {
    const [row] = await c.var.withOrganization((tx) =>
      tx
        .select({ ...getTableColumns(schema.control), version })
        .from(schema.control)
        .where(eq(schema.control.id, c.req.param("controlId"))),
    );
    if (!row) return c.json(failure("not_found", "No such control."), 404);

    // What a conditional write quotes back, so that what is changed is what
    // was read (ADR 0019).
    c.header("etag", entityTag(row));
    return c.json({ data: withoutVersion(row) });
  })

  .get("/controls/:controlId/requirements", knownControlId, async (c) => {
    const controlId = c.req.param("controlId");
    const ordering = controlRequirementsOrder(controlId);
    const query = collectionQuery(ordering).safeParse(c.req.query());
    if (!query.success) return c.json(rejection("query", query.error), 400);
    const { limit, cursor } = query.data;

    const found = await c.var.withOrganization(
      async (tx) => {
        const [control] = await tx
          .select({ id: schema.control.id })
          .from(schema.control)
          .where(eq(schema.control.id, controlId));
        if (!control) return undefined;

        // The whole set's version travels with every page of it, so a client that
        // paged through and then wrote is writing against what it read. Read from
        // the same snapshot as the page below — under `read committed` these are
        // two statements and can see two different committed sets, which would
        // hand a client a version for membership it was not shown.
        const mapped = await mappedTo(tx, controlId);
        return tx
          .select({ ...getTableColumns(schema.requirement), cursorAt: cursorAt(ordering) })
          .from(schema.controlRequirement)
          .innerJoin(
            schema.requirement,
            eq(schema.requirement.id, schema.controlRequirement.requirementId),
          )
          .where(
            and(
              eq(schema.controlRequirement.controlId, controlId),
              cursor ? rowsAfter(ordering, cursor) : undefined,
            ),
          )
          .orderBy(...orderedBy(ordering))
          .limit(limit + 1)
          .then((rows) => ({ rows, mapped }));
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such control."), 404);

    const { rows, nextCursor } = page(found.rows, limit, ordering);
    c.header("etag", entityTag({ version: setVersion(found.mapped) }));
    return c.json({ data: rows, nextCursor });
  })

  .put(
    "/controls/:controlId/requirements",
    knownControlId,
    jsonBody(controlRequirementsBody),
    async (c) => {
      const controlId = c.req.param("controlId");
      // A set: the same requirement named twice is named once.
      const wanted = [...new Set(c.req.valid("json").requirementIds)];

      const result = await c.var.withOrganization(async (tx) => {
        const [control] = await tx
          .select({ id: schema.control.id })
          .from(schema.control)
          .where(eq(schema.control.id, controlId))
          .for("update");
        if (!control) return { outcome: "missing" } as const;

        const known = await lockRequirements(tx, wanted);
        const unknown = wanted.filter((id) => !known.some((row) => row.id === id));
        if (unknown.length > 0) return { outcome: "unknown", unknown } as const;

        const before = await mappedTo(tx, controlId);

        // Compared under the lock taken above, so the set cannot change between
        // the test and the replacement. A set has no `xmin`, so its contents
        // are its version (ADR 0019).
        if (
          ifMatch(c.req.header("if-match"), entityTag({ version: setVersion(before) })) === "failed"
        ) {
          return { outcome: "stale" } as const;
        }

        const after = [...wanted].sort();
        const removed = before.filter((id) => !wanted.includes(id));
        const added = wanted.filter((id) => !before.includes(id));

        if (removed.length > 0) {
          await tx
            .delete(schema.controlRequirement)
            .where(
              and(
                eq(schema.controlRequirement.controlId, controlId),
                inArray(schema.controlRequirement.requirementId, removed),
              ),
            );
        }
        if (added.length > 0) {
          await tx.insert(schema.controlRequirement).values(
            added.map((requirementId) => ({
              organizationId: c.var.member.organizationId,
              controlId,
              requirementId,
            })),
          );
        }

        // A mapping change is a change to the control, not an event about a link:
        // the link has no life of its own (ADR 0010). Nothing changed, nothing
        // recorded — the request is idempotent all the way down.
        if (added.length > 0 || removed.length > 0) {
          await c.var.audit(tx, {
            action: "updated",
            resourceType: "control",
            resourceId: controlId,
            before: { requirementIds: before },
            after: { requirementIds: after },
          });
        }

        return { outcome: "set", requirementIds: after } as const;
      });

      if (result.outcome === "missing") {
        return c.json(failure("not_found", "No such control."), 404);
      }
      if (result.outcome === "stale") return staleRequirements(c);
      if (result.outcome === "unknown") {
        return c.json(
          failure(
            "invalid_request",
            "Some requirements are not here.",
            result.unknown.map((id) => ({
              path: "requirementIds",
              message: `No such requirement: ${id}.`,
            })),
          ),
          400,
        );
      }
      // The new version, so a client can make a second change without reading
      // the whole set again.
      c.header("etag", entityTag({ version: setVersion(result.requirementIds) }));
      return c.json({ data: { requirementIds: result.requirementIds } });
    },
  )

  .patch("/controls/:controlId", knownControlId, jsonBody(updateBody), async (c) => {
    const body = c.req.valid("json");
    const controlId = c.req.param("controlId");

    // Read and write in one transaction, with the row locked: the status rule
    // is decided from what is currently stored, and two concurrent patches must
    // not both get to see the old value (ADR 0003 — one callback, one
    // transaction).
    const result = await c.var.withOrganization(async (tx) => {
      const [current] = await tx
        .select({ ...getTableColumns(schema.control), version })
        .from(schema.control)
        .where(eq(schema.control.id, controlId))
        .for("update");
      if (!current) return { outcome: "missing" } as const;

      if (
        body.status &&
        body.status !== current.status &&
        !transitions[current.status].includes(body.status)
      ) {
        return { outcome: "illegal", from: current.status, to: body.status } as const;
      }

      // Last of the refusals, and after the lock. A precondition answers a
      // request that would otherwise have succeeded (RFC 9110 §13.2.1) — asking
      // first would let a refused request disclose whether its tag matched.
      if (ifMatch(c.req.header("if-match"), entityTag(current)) === "failed") {
        return { outcome: "stale" } as const;
      }

      // Nothing different means nothing to write. An UPDATE would still move
      // the row's version and `updated_at`, so a request setting the values a
      // control already has would stale every other client's tag while
      // history said nothing happened.
      const changed = diffFields(
        fieldsOf(current, audited),
        fieldsOf({ ...current, ...body }, audited),
      );
      if (!changed) return { outcome: "updated", row: current } as const;

      const [row] = await tx
        .update(schema.control)
        // `activated_at` is not set here. A trigger sets it the first time a
        // control becomes active and refuses any other write, and a CHECK ties
        // a draft to its absence — which is what lets the DELETE policy test
        // the status alone (ADR 0017).
        .set(body)
        .where(eq(schema.control.id, controlId))
        .returning({ ...getTableColumns(schema.control), version });

      await c.var.audit(tx, {
        action: "updated",
        resourceType: "control",
        resourceId: controlId,
        before: changed.before,
        after: changed.after,
      });

      // The row was locked and found, so the update matched it.
      return { outcome: "updated", row: row! } as const;
    });

    if (result.outcome === "missing") {
      return c.json(failure("not_found", "No such control."), 404);
    }
    if (result.outcome === "illegal") {
      return c.json(
        failure("invalid_transition", `A control cannot go from ${result.from} to ${result.to}.`, [
          {
            path: "status",
            message: transitions[result.from].length
              ? `Allowed from ${result.from}: ${transitions[result.from].join(", ")}.`
              : `A ${result.from} control stays ${result.from}; author a new one instead.`,
          },
        ]),
        409,
      );
    }

    if (result.outcome === "stale") return staleControl(c);

    c.header("etag", entityTag(result.row));
    return c.json({ data: withoutVersion(result.row) });
  })

  .delete("/controls/:controlId", knownControlId, async (c) => {
    const controlId = c.req.param("controlId");

    // Only a draft. A control that was in effect is part of the record and is
    // retired rather than removed; a draft claims nothing, and retiring it would
    // record that it had been in effect (ADR 0017). What it carries is not
    // lost: evidence refuses the delete, and the audit history stays. The policy
    // says the same thing, so this is the courteous answer rather than the
    // enforcement.
    const result = await c.var.withOrganization(async (tx) => {
      // Locked for the same reason `PATCH` locks: the decision is made from
      // what is stored, and a concurrent patch must not activate it in between.
      const [current] = await tx
        .select({ ...getTableColumns(schema.control), version })
        .from(schema.control)
        .where(eq(schema.control.id, controlId))
        .for("update");
      if (!current) return { outcome: "missing" } as const;

      // A draft is exactly a control that never took effect — the database
      // holds that — so the status is the whole question, as it is for the
      // policy.
      if (current.status !== "draft") {
        return { outcome: "in_effect", status: current.status } as const;
      }

      // Evidence outlives the control it was recorded against — the foreign key
      // restricts rather than cascades, so that attested evidence cannot be
      // disposed of by removing what it is evidence of (ADR 0014). Asked here
      // so the answer is a 409 naming the reason rather than a 500.
      const [evidence] = await tx
        .select({ id: schema.evidence.id })
        .from(schema.evidence)
        .where(eq(schema.evidence.controlId, controlId))
        .limit(1);
      if (evidence) return { outcome: "has_evidence" } as const;

      // Last, for the same reason as the amendment above: a control that could
      // not be discarded anyway must answer why, not whether the tag matched.
      if (ifMatch(c.req.header("if-match"), entityTag(current)) === "failed") {
        return { outcome: "stale" } as const;
      }

      const [removed] = await tx
        .delete(schema.control)
        .where(eq(schema.control.id, controlId))
        .returning({ id: schema.control.id });
      // The lock above is what makes this impossible: a locked draft is one the
      // policy admits. A delete matching nothing must still not be answered
      // 204, and there is no honest 4xx for it.
      if (!removed) throw new Error(`Control ${controlId} was locked as a draft but not deleted.`);

      // Written after the row is gone, and it survives it: `resource_id` is a
      // plain column, not a reference, so history outlives what it describes.
      await c.var.audit(tx, {
        action: "deleted",
        resourceType: "control",
        resourceId: controlId,
        before: fieldsOf(current, audited),
      });

      return { outcome: "discarded" } as const;
    });

    if (result.outcome === "missing") {
      return c.json(failure("not_found", "No such control."), 404);
    }
    if (result.outcome === "in_effect") {
      const advice = {
        active: "Retire it instead; a control that has been in effect is part of the record.",
        retired: "A retired control is part of the record and is kept.",
      }[result.status];
      return c.json(
        failure("was_in_effect", "The control has been in effect.", [
          { path: "status", message: advice },
        ]),
        409,
      );
    }
    if (result.outcome === "stale") return staleControl(c);
    if (result.outcome === "has_evidence") {
      return c.json(
        failure("has_evidence", "The control carries evidence.", [
          { path: "", message: "A control that has evidence cannot be discarded." },
        ]),
        409,
      );
    }

    return c.body(null, 204);
  });
