// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Evidence routes.
 *
 * Evidence is recorded against a control and read by its own identifier, the
 * way a requirement is (ADR 0011). Attesting it is a separate act with a route
 * of its own, because it is the point after which the record stops being
 * editable — reasoning in `docs/adr/0012-evidence-and-attestation.md`.
 */

import { idPattern, schema, type TenantTransaction } from "@qualityruntime/db";
import { and, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { diffFields, fieldsOf } from "./audit.ts";
import type { OrganizationEnv } from "./organization.ts";
import {
  collectionQuery,
  type Cursor,
  cursorAt,
  newestFirst,
  type Ordering,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { entityTag, ifMatch, rowVersion } from "./preconditions.ts";
import { failure } from "./responses.ts";
import { instant, jsonBody, prose, rejection, words } from "./validation.ts";

/**
 * A moment that has already been.
 *
 * Evidence of something that has not happened is not evidence, and once
 * attested it cannot be corrected — so a future date is refused where it is
 * cheapest, on the way in. A few minutes of tolerance, because a client's clock
 * being slightly ahead is ordinary and being wrong about the future is not.
 */
const clockSkew = 5 * 60 * 1000;
const notInTheFuture = () =>
  instant()
    .refine(
      (value) => Date.parse(value) <= Date.now() + clockSkew,
      "Must not be more than five minutes in the future.",
    )
    .meta({
      description:
        "When the thing happened, as an ISO 8601 instant with an offset. The UTC year must be " +
        "from 0001 through 9999. Must not be more than five minutes in the future, an " +
        "allowance for a client clock running ahead.",
    });

const recordBody = z.object({
  title: words(200),
  description: prose(10_000).nullish(),
  /** When the thing happened. Required: undated evidence evidences little. */
  occurredAt: notInTheFuture(),
});

/** Partial amendment: at least one field is required. The handler permits drafts only. */
const amendBody = z
  .object({
    title: words(200).optional(),
    description: prose(10_000).nullable().optional(),
    occurredAt: notInTheFuture().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to change.",
  })
  .meta({
    anyOf: [{ required: ["title"] }, { required: ["description"] }, { required: ["occurredAt"] }],
    description: "At least one of title, description or occurredAt.",
  });

export { recordBody as evidenceBody, amendBody as evidenceAmendBody };

/** Evidence, as a client sees it. The attestation reads as one thing. */
export const evidenceResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  controlId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  occurredAt: z.iso.datetime(),
  attestation: z
    .strictObject({
      at: z.iso.datetime(),
      by: z.strictObject({ id: z.string(), label: z.string().nullable() }),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const version = rowVersion(schema.evidence);

/** A control's evidence, most recently occurred first. */
export const evidenceOrder = (controlId: string) =>
  newestFirst(`control-evidence/${controlId}`, schema.evidence.occurredAt, schema.evidence.id);

/**
 * The evidence of the controls mapped to a requirement, in the same order.
 * Scoped to the requirement, like every cursor.
 */
export const requirementEvidenceOrder = (requirementId: string) =>
  newestFirst(
    `requirement-evidence/${requirementId}`,
    schema.evidence.occurredAt,
    schema.evidence.id,
  );

/** The one answer for an `If-Match` that no longer names this evidence. */
const staleEvidence = (c: Context) =>
  c.json(
    failure("precondition_failed", "If-Match does not match the evidence's current ETag.", [
      { path: "", message: "Read it again, and decide against what it now says." },
    ]),
    412,
  );

/**
 * What an empty locked read means: attested, or gone.
 *
 * `select … for update` is governed by the UPDATE policy, which sees only
 * unattested rows — so an attested row is not there to lock. It is also not
 * there if it was deleted while this transaction waited for the lock, and the
 * two are indistinguishable from the lock alone. Reading again without one
 * tells them apart; answering "already attested" for a record that was
 * discarded and never signed is a confident wrong answer.
 */
async function whyNotLocked(
  tx: TenantTransaction,
  evidenceId: string,
): Promise<{ outcome: "attested" } | { outcome: "missing" }> {
  const [present] = await tx
    .select({ id: schema.evidence.id })
    .from(schema.evidence)
    .where(eq(schema.evidence.id, evidenceId));
  return present ? { outcome: "attested" } : { outcome: "missing" };
}

const isEvidenceId = new RegExp(idPattern("evidence"));

const knownEvidenceId = createMiddleware(async (c, next) => {
  if (!isEvidenceId.test(c.req.param("evidenceId") ?? "")) {
    return c.json(failure("not_found", "No such evidence."), 404);
  }
  await next();
});

/**
 * What audit history records about evidence. `controlId` never changes, but
 * once discarded evidence is gone, its history is the only record of which
 * control it belonged to.
 */
const audited = ["controlId", "title", "description", "occurredAt"] as const;

type Row = typeof schema.evidence.$inferSelect;

/** One page of evidence narrowed by `where`. */
async function evidencePage(
  tx: TenantTransaction,
  ordering: Ordering,
  { where, limit, cursor }: { where: SQL; limit: number; cursor: Cursor | undefined },
) {
  const rows = await tx
    .select({ ...getTableColumns(schema.evidence), cursorAt: cursorAt(ordering) })
    .from(schema.evidence)
    .where(and(where, cursor ? rowsAfter(ordering, cursor) : undefined))
    .orderBy(...orderedBy(ordering))
    .limit(limit + 1);
  return rows;
}

const evidenceShape = (row: Row) => ({
  id: row.id,
  organizationId: row.organizationId,
  controlId: row.controlId,
  title: row.title,
  description: row.description,
  occurredAt: row.occurredAt,
  attestation:
    row.attestedAt && row.attestedById
      ? { at: row.attestedAt, by: { id: row.attestedById, label: row.attestedByLabel } }
      : null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const evidence = new Hono<OrganizationEnv>()
  .get("/controls/:controlId/evidence", async (c) => {
    const controlId = c.req.param("controlId");
    if (!new RegExp(idPattern("control")).test(controlId)) {
      return c.json(failure("not_found", "No such control."), 404);
    }
    const ordering = evidenceOrder(controlId);
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

        return evidencePage(tx, ordering, {
          where: eq(schema.evidence.controlId, controlId),
          limit,
          cursor,
        });
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such control."), 404);

    const { rows, nextCursor } = page(found, limit, ordering);
    return c.json({ data: rows.map(evidenceShape), nextCursor });
  })

  /**
   * The evidence recorded for the controls currently mapped to a requirement —
   * drafts and attested, from controls in any state. Not coverage: a mapping
   * is an intention and an attestation endorses the evidence, not the mapping
   * (ADR 0012). Unmapping a control takes its evidence out of this view and
   * leaves the evidence as it was.
   */
  .get("/requirements/:requirementId/evidence", async (c) => {
    const requirementId = c.req.param("requirementId");
    if (!new RegExp(idPattern("requirement")).test(requirementId)) {
      return c.json(failure("not_found", "No such requirement."), 404);
    }
    const ordering = requirementEvidenceOrder(requirementId);
    const query = collectionQuery(ordering).safeParse(c.req.query());
    if (!query.success) return c.json(rejection("query", query.error), 400);
    const { limit, cursor } = query.data;

    const found = await c.var.withOrganization(
      async (tx) => {
        // Visible first, or its absence would read as a requirement with no
        // evidence.
        const [requirement] = await tx
          .select({ id: schema.requirement.id })
          .from(schema.requirement)
          .where(eq(schema.requirement.id, requirementId));
        if (!requirement) return undefined;

        // A semi-join rather than a join: each evidence row has one control
        // and each mapping is unique per pair, so a join could not duplicate a
        // row today — but `in` says "evidence of a mapped control" and cannot
        // start to.
        return evidencePage(tx, ordering, {
          where: inArray(
            schema.evidence.controlId,
            tx
              .select({ controlId: schema.controlRequirement.controlId })
              .from(schema.controlRequirement)
              .where(eq(schema.controlRequirement.requirementId, requirementId)),
          ),
          limit,
          cursor,
        });
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such requirement."), 404);

    const { rows, nextCursor } = page(found, limit, ordering);
    return c.json({ data: rows.map(evidenceShape), nextCursor });
  })

  .post("/controls/:controlId/evidence", jsonBody(recordBody), async (c) => {
    const controlId = c.req.param("controlId");
    if (!new RegExp(idPattern("control")).test(controlId)) {
      return c.json(failure("not_found", "No such control."), 404);
    }
    const body = c.req.valid("json");

    const result = await c.var.withOrganization(async (tx) => {
      // `for key share` is the lock the foreign key below will take anyway,
      // taken early and held for the whole transaction. It conflicts with the
      // `for update` a discard holds, so the two cannot interleave: whichever
      // arrives second waits and then sees the world the first left. Without
      // it, a control discarded in between turned this into a foreign key
      // violation and a 500 (ADR 0020).
      //
      // It does not conflict with itself, so evidence being recorded against
      // the same control concurrently is unaffected.
      const [control] = await tx
        .select({ id: schema.control.id })
        .from(schema.control)
        .where(eq(schema.control.id, controlId))
        .for("key share");
      if (!control) return undefined;

      const [row] = await tx
        .insert(schema.evidence)
        .values({
          organizationId: c.var.member.organizationId,
          controlId,
          title: body.title,
          description: body.description ?? null,
          occurredAt: new Date(body.occurredAt),
        })
        .returning({ ...getTableColumns(schema.evidence), version });

      await c.var.audit(tx, {
        action: "created",
        resourceType: "evidence",
        resourceId: row!.id,
        after: fieldsOf(row!, audited),
      });
      return row!;
    });
    if (!result) return c.json(failure("not_found", "No such control."), 404);

    // Its tag, so that what was just recorded can be attested without reading
    // it again: the body is what the client has now seen.
    c.header("etag", entityTag(result));
    return c.json({ data: evidenceShape(result) }, 201);
  })

  .get("/evidence/:evidenceId", knownEvidenceId, async (c) => {
    const evidenceId = c.req.param("evidenceId");
    const [row] = await c.var.withOrganization((tx) =>
      tx
        .select({ ...getTableColumns(schema.evidence), version })
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId)),
    );
    if (!row) return c.json(failure("not_found", "No such evidence."), 404);

    // What an attestation has to quote back, so that what was signed is what
    // was read.
    c.header("etag", entityTag(row));
    return c.json({ data: evidenceShape(row) });
  })

  .patch("/evidence/:evidenceId", knownEvidenceId, jsonBody(amendBody), async (c) => {
    const evidenceId = c.req.param("evidenceId");
    const body = c.req.valid("json");

    const result = await c.var.withOrganization(async (tx) => {
      // Read without locking. `select … for update` is governed by the UPDATE
      // policy as well as the SELECT one, so an attested row is not there to
      // lock — and "cannot be locked" would come back as "does not exist".
      const [current] = await tx
        .select()
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId));
      if (!current) return { outcome: "missing" } as const;
      if (current.attestedAt) return { outcome: "attested" } as const;

      // Lock before computing the diff: a concurrent amendment could make an
      // unlocked preimage stale, corrupting the audit diff or making a real
      // change look like a no-op.
      const [locked] = await tx
        .select({ ...getTableColumns(schema.evidence), version })
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId))
        .for("update");
      // It may have been attested or discarded while waiting for the lock.
      if (!locked) return whyNotLocked(tx, evidenceId);

      // Compared after the lock, so the version cannot move between the test
      // and the write — no need to repeat it in the WHERE below.
      if (ifMatch(c.req.header("if-match"), entityTag(locked)) === "failed") {
        return { outcome: "stale" } as const;
      }

      const updates = {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.occurredAt === undefined ? {} : { occurredAt: new Date(body.occurredAt) }),
      };
      // Nothing different means nothing to write. An UPDATE would still move
      // the version, staling the tag an attester is about to quote while
      // history said nothing happened — the rule controls follow too.
      const changed = diffFields(
        fieldsOf(locked, audited),
        fieldsOf({ ...locked, ...updates }, audited),
      );
      if (!changed) return { outcome: "amended", row: locked } as const;

      const [row] = await tx
        .update(schema.evidence)
        .set(updates)
        .where(eq(schema.evidence.id, evidenceId))
        .returning({ ...getTableColumns(schema.evidence), version });
      // The lock makes this impossible: a locked row is an unattested one, and
      // nothing can attest it until this transaction ends.
      if (!row) throw new Error(`Evidence ${evidenceId} was locked as a draft but not amended.`);

      await c.var.audit(tx, {
        action: "updated",
        resourceType: "evidence",
        resourceId: evidenceId,
        before: changed.before,
        after: changed.after,
      });
      return { outcome: "amended", row } as const;
    });

    if (result.outcome === "missing") {
      return c.json(failure("not_found", "No such evidence."), 404);
    }
    if (result.outcome === "attested") {
      return c.json(
        failure("already_attested", "Attested evidence cannot be changed.", [
          { path: "", message: "Record new evidence instead." },
        ]),
        409,
      );
    }
    if (result.outcome === "stale") return staleEvidence(c);

    c.header("etag", entityTag(result.row));
    return c.json({ data: evidenceShape(result.row) });
  })

  .delete("/evidence/:evidenceId", knownEvidenceId, async (c) => {
    const evidenceId = c.req.param("evidenceId");

    // Only unattested evidence may be discarded (ADR 0012). Removing it lets
    // a draft control with no remaining evidence be discarded too (ADR 0017).
    const result = await c.var.withOrganization(async (tx) => {
      // Read unlocked first, for the same reason the amendment does: `select …
      // for update` is governed by the UPDATE policy, so an attested row is
      // not there to lock, and "cannot be locked" would come back as "does not
      // exist".
      const [current] = await tx
        .select({ id: schema.evidence.id, attestedAt: schema.evidence.attestedAt })
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId));
      // This read is what tells 404 from 409: a lock that finds nothing cannot
      // say whether the row was absent or attested.
      if (!current) return { outcome: "missing" } as const;
      if (current.attestedAt) return { outcome: "attested" } as const;

      // Now that it is known to be a draft, lock it — and compare the version
      // against the locked row. Comparing an unlocked read would leave the row
      // free to be amended between the test and the delete, which is exactly
      // what a conditional write is for (ADR 0019).
      const [locked] = await tx
        .select({ ...getTableColumns(schema.evidence), version })
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId))
        .for("update");
      // It may have been attested or discarded while waiting for the lock.
      if (!locked) return whyNotLocked(tx, evidenceId);

      if (ifMatch(c.req.header("if-match"), entityTag(locked)) === "failed") {
        return { outcome: "stale" } as const;
      }

      const [removed] = await tx
        .delete(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId))
        .returning();
      // Impossible under the lock, for the same reason as the amendment.
      if (!removed)
        throw new Error(`Evidence ${evidenceId} was locked as a draft but not deleted.`);

      await c.var.audit(tx, {
        action: "deleted",
        resourceType: "evidence",
        resourceId: evidenceId,
        before: fieldsOf(locked, audited),
      });

      return { outcome: "discarded" } as const;
    });

    if (result.outcome === "missing") {
      return c.json(failure("not_found", "No such evidence."), 404);
    }
    if (result.outcome === "attested") {
      return c.json(
        failure("already_attested", "Attested evidence cannot be removed.", [
          { path: "", message: "What was attested is kept; record a correction instead." },
        ]),
        409,
      );
    }
    if (result.outcome === "stale") return staleEvidence(c);
    return c.body(null, 204);
  })

  .put("/evidence/:evidenceId/attestation", knownEvidenceId, async (c) => {
    const evidenceId = c.req.param("evidenceId");
    // An administrator acting as a member may do that member's work; vouching
    // is not work, it is a signature, and signing as somebody else is forgery
    // however it is logged (ADR 0012).
    // Signing means signing something in particular. Without this a client can
    // attest content it never saw, because someone amended the draft between
    // the read and the signature.
    const ifMatch = c.req.header("if-match");
    if (ifMatch === undefined) {
      return c.json(
        failure("precondition_required", "Attesting requires the If-Match of the evidence read.", [
          { path: "", message: "Read the evidence and quote its ETag back." },
        ]),
        428,
      );
    }
    if (c.var.actor.onBehalfOf) {
      return c.json(
        failure("impersonated", "Evidence cannot be attested while impersonating.", [
          { path: "", message: "Attesting is a personal act and is not delegated." },
        ]),
        403,
      );
    }

    const result = await c.var.withOrganization(async (tx) => {
      // Unlocked, for the same reason as the amend above.
      const [current] = await tx
        .select({ id: schema.evidence.id, attestedAt: schema.evidence.attestedAt, version })
        .from(schema.evidence)
        .where(eq(schema.evidence.id, evidenceId));
      if (!current) return { outcome: "missing" } as const;
      if (current.attestedAt) return { outcome: "attested" } as const;
      if (ifMatch !== entityTag(current)) return { outcome: "stale" } as const;

      // The version goes in the WHERE as well, so the check and the write are
      // one statement: an amendment landing in between matches nothing.
      const [row] = await tx
        .update(schema.evidence)
        .set({
          // The database's clock, which audit history uses too, rather than
          // whichever server handled the request.
          attestedAt: sql`clock_timestamp()`,
          attestedById: c.var.actor.id,
          attestedByLabel: c.var.actor.label,
        })
        .where(and(eq(schema.evidence.id, evidenceId), sql`${version} = ${current.version}`))
        .returning();
      if (!row) {
        // Matching nothing is also what attested or discarded meanwhile look
        // like, and those have answers of their own. Read again to tell them
        // apart, as the amend and discard do after an empty lock.
        const [now] = await tx
          .select({ attestedAt: schema.evidence.attestedAt })
          .from(schema.evidence)
          .where(eq(schema.evidence.id, evidenceId));
        if (!now) return { outcome: "missing" } as const;
        if (now.attestedAt) return { outcome: "attested" } as const;
        return { outcome: "stale" } as const;
      }

      await c.var.audit(tx, {
        action: "attested",
        resourceType: "evidence",
        resourceId: evidenceId,
        after: { attestedAt: row.attestedAt, attestedById: row.attestedById },
      });
      return { outcome: "attested_now", row } as const;
    });

    if (result.outcome === "missing") {
      return c.json(failure("not_found", "No such evidence."), 404);
    }
    if (result.outcome === "attested") {
      return c.json(
        failure("already_attested", "This evidence has already been attested.", [
          { path: "", message: "An attestation is one act and is not repeated." },
        ]),
        409,
      );
    }
    if (result.outcome === "stale") {
      return c.json(
        failure("precondition_failed", "If-Match does not match the evidence's current ETag.", [
          { path: "", message: "Read it again, and attest what it now says." },
        ]),
        412,
      );
    }
    return c.json({ data: evidenceShape(result.row) });
  });
