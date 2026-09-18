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

import { idPattern, schema } from "@qualityruntime/db";
import { eq, getTableColumns } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { diffFields, fieldsOf } from "./audit.ts";
import { entityTag, ifMatch, rowVersion, withoutVersion } from "./preconditions.ts";
import { failure } from "./responses.ts";
import type { OrganizationEnv } from "./organization.ts";
import {
  collectionQuery,
  cursorAt,
  newestFirst,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { jsonBody, prose, queryParams, words } from "./validation.ts";

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
 * and a withdrawn one stays withdrawn — what replaces it is a new control, so
 * the one evidence was recorded against keeps meaning what it meant. Setting
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

/** The one answer for an `If-Match` that no longer names this control. */
const staleControl = (c: Context) =>
  c.json(
    failure("precondition_failed", "The control changed since it was read.", [
      { path: "", message: "Read it again, and decide against what it now says." },
    ]),
    412,
  );

const isControlId = new RegExp(idPattern("control"));

/** Controls and their history are both records of what has happened. */
export const controlOrder = newestFirst("controls", schema.control.createdAt, schema.control.id);
/** A control, as a client sees it. Strict, so a new column cannot slip out. */
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
    // retired rather than removed; a draft claims nothing and was never relied
    // on, so there is nothing about it to keep (ADR 0017). The policy says the
    // same thing, so this is the courteous answer rather than the enforcement.
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
      // 204, and there is no honest 4xx for it. Evidence checks the same thing.
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
        active: "Retire it instead; a control that was relied on is part of the record.",
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
