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
import { and, asc, eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
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
import { fileResponse } from "./files.ts";
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
  /** What is attached. Evidence carries few enough files to list them here. */
  files: z.array(fileResponse),
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

type Attachment = typeof schema.file.$inferSelect;

/**
 * The files attached to each of `ids`, oldest first.
 *
 * One query for a whole page rather than one per row. A piece of evidence
 * carries at most a score of files, so listing them with it is cheaper than
 * making a client ask separately for every one.
 */
async function attachments(tx: TenantTransaction, ids: string[]) {
  if (ids.length === 0) return new Map<string, Attachment[]>();
  const rows = await tx
    .select()
    .from(schema.file)
    .where(inArray(schema.file.evidenceId, ids))
    .orderBy(asc(schema.file.createdAt), asc(schema.file.id));

  const byEvidence = new Map<string, Attachment[]>();
  for (const row of rows) {
    byEvidence.set(row.evidenceId, [...(byEvidence.get(row.evidenceId) ?? []), row]);
  }
  return byEvidence;
}

/**
 * One page of evidence narrowed by `where`, with its attachments.
 *
 * Takes the transaction it runs in, which its callers open as repeatable read:
 * the page and its attachments are separate statements, and a file landing
 * between them would appear against evidence the page read before it existed.
 */
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
  return {
    rows,
    files: await attachments(
      tx,
      rows.map((row) => row.id),
    ),
  };
}

/** Every caller states the attachments: a default would hide an empty one. */
const evidenceShape = (row: Row, files: Attachment[]) => ({
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
  files,
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

    const { rows, nextCursor } = page(found.rows, limit, ordering);
    return c.json({
      data: rows.map((row) => evidenceShape(row, found.files.get(row.id) ?? [])),
      nextCursor,
    });
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

    const { rows, nextCursor } = page(found.rows, limit, ordering);
    return c.json({
      data: rows.map((row) => evidenceShape(row, found.files.get(row.id) ?? [])),
      nextCursor,
    });
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
    return c.json({ data: evidenceShape(result, []) }, 201);
  })

  .get("/evidence/:evidenceId", knownEvidenceId, async (c) => {
    const evidenceId = c.req.param("evidenceId");
    // One snapshot: the row and its files are two statements, and under `read
    // committed` a file attached between them would be shown beside a version
    // that predates it. The tag below is what an attestation quotes, so "what
    // was signed is what was read" depends on the two agreeing (ADR 0019).
    const found = await c.var.withOrganization(
      async (tx) => {
        const [row] = await tx
          .select({ ...getTableColumns(schema.evidence), version })
          .from(schema.evidence)
          .where(eq(schema.evidence.id, evidenceId));
        if (!row) return undefined;
        return { row, files: (await attachments(tx, [evidenceId])).get(evidenceId) ?? [] };
      },
      { repeatableRead: true },
    );
    if (!found) return c.json(failure("not_found", "No such evidence."), 404);

    // What an attestation has to quote back, so that what was signed is what
    // was read.
    c.header("etag", entityTag(found.row));
    return c.json({ data: evidenceShape(found.row, found.files) });
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
      if (!changed) {
        return {
          outcome: "amended",
          row: locked,
          files: (await attachments(tx, [evidenceId])).get(evidenceId) ?? [],
        } as const;
      }

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
      return {
        outcome: "amended",
        row,
        files: (await attachments(tx, [evidenceId])).get(evidenceId) ?? [],
      } as const;
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
    return c.json({ data: evidenceShape(result.row, result.files) });
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

      // `file` cascades from evidence, so its rows go here. The bytes do not —
      // a foreign key cannot reach a bucket — and they are left for
      // `bun run reclaim:storage`, which is the only thing that removes them
      // (ADR 0021). Read first so the audit event can say what went: once the
      // rows are gone it is the only record of what was attached.
      const files = await tx
        .select({
          id: schema.file.id,
          filename: schema.file.filename,
          contentType: schema.file.contentType,
          bytes: schema.file.bytes,
          checksum: schema.file.checksum,
        })
        .from(schema.file)
        .where(eq(schema.file.evidenceId, evidenceId))
        // The order the evidence listed them in, so the event reads like the
        // record it is replacing rather than like whatever the scan returned.
        .orderBy(asc(schema.file.createdAt), asc(schema.file.id));

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
        // Each named the way the attachment event named it. Filenames repeat
        // legally, so a list of them alone could not say which file went —
        // and the identifier is also the storage key `reclaim:storage` will
        // report when it removes the bytes.
        before: { ...fieldsOf(locked, audited), files },
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
      return {
        outcome: "attested_now",
        row,
        files: (await attachments(tx, [evidenceId])).get(evidenceId) ?? [],
      } as const;
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
    return c.json({ data: evidenceShape(result.row, result.files) });
  });
