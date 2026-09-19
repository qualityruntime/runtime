// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File routes: attaching bytes to evidence, and reading them back.
 *
 * The bytes are the request body, not a multipart part — reasoning in
 * `docs/adr/0013-durable-storage.md`. What a file is, and who may read it, is
 * decided in PostgreSQL; storage is asked only for bytes under a key it was
 * given (DATA-01).
 */

import { createId, idPattern, schema, type TenantTransaction } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { OrganizationEnv } from "./organization.ts";
import { failure } from "./responses.ts";
import { type FileStore, TooManyBytes } from "./storage.ts";
import { rejection, words } from "./validation.ts";

/**
 * The largest file this accepts.
 *
 * Generous for the minutes, screenshots and exports evidence is made of, and
 * far short of what a mounted volume would notice. Counted as the bytes arrive
 * rather than trusted from a header.
 */
export const maxFileBytes = 25 * 1024 * 1024;

/** How many files one piece of evidence may carry. */
export const maxFilesPerEvidence = 20;

/**
 * A media type, checked to be one.
 *
 * This value is written straight into a response header when the file is read
 * back, and an unusable one cannot be repaired: `file` has no UPDATE policy and
 * an attested record's attachments cannot be removed. So a bad content type is
 * refused at the door rather than stored and discovered later.
 *
 * `type/subtype` and nothing after it. Parameters are not accepted: every file
 * is served as an attachment with `nosniff`, so nothing downstream would ever
 * interpret a `charset`. The quote and the backtick are left out of RFC 9110's
 * token set, since no real media type uses either.
 *
 * A pattern rather than a refinement, so it survives into the published schema
 * (ADR 0007). `file_content_type_shape` in the database says the same thing —
 * this is the courteous 400, that is the guarantee.
 */
const token = "[A-Za-z0-9!#$%&*+.^_|~-]+";
const mediaType = new RegExp(`^${token}/${token}$`);

/**
 * What a client sends about the file, beside the bytes.
 *
 * In the query rather than the body, because the body is the file. The name is
 * for display and is never a path: the key is the identifier PostgreSQL issued.
 */
// Strict: a misspelt `contentType` would otherwise store the default for good,
// since an attached file cannot be changed.
export const uploadQuery = z.strictObject({
  filename: words(255),
  contentType: z
    .string()
    .max(255)
    .regex(mediaType, "Must be a media type, such as application/pdf.")
    .optional(),
});

export const fileResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  evidenceId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  bytes: z.int().positive(),
  checksum: z.string(),
  createdAt: z.iso.datetime(),
});

/**
 * Whether evidence is here, visible, and still open to attachments.
 *
 * `lock` takes `for no key update` on the evidence, held for the transaction —
 * the lock `file_evidence_open` takes on insert, taken earlier so that what is
 * decided here stays true until then. That trigger is what keeps an attested
 * record from gaining a file; this is what lets the handler say why it refused,
 * and what makes the count hold: the lock conflicts with another attachment's,
 * so two uploads cannot both count the same room and use it. It also conflicts
 * with the `for update` a discard holds, so an insert never points at evidence
 * that has gone.
 *
 * Not `for share`, which conflicts with an attestation but not with itself:
 * this handler goes on to update the evidence's own row, so two attachments
 * would each hold a share the other's update waits for, and deadlock.
 *
 * The check before the bytes are written asks without it: that one is only
 * avoiding obvious waste, and it has no insert to protect.
 */
async function evidenceState(
  tx: TenantTransaction,
  evidenceId: string,
  { lock = false }: { lock?: boolean } = {},
) {
  const asked = tx
    .select({ id: schema.evidence.id, attestedAt: schema.evidence.attestedAt })
    .from(schema.evidence)
    .where(eq(schema.evidence.id, evidenceId));
  const [evidence] = await (lock ? asked.for("no key update") : asked);
  if (!evidence) return { outcome: "missing" } as const;
  if (evidence.attestedAt) return { outcome: "attested" } as const;

  const attached = await tx
    .select({ id: schema.file.id })
    .from(schema.file)
    .where(eq(schema.file.evidenceId, evidenceId));
  if (attached.length >= maxFilesPerEvidence) return { outcome: "too_many" } as const;

  return { outcome: "ready" } as const;
}

/** The one answer for each way an attachment can be refused. */
const refuse = (c: Context, outcome: "missing" | "attested" | "too_many") => {
  if (outcome === "missing") return c.json(failure("not_found", "No such evidence."), 404);
  if (outcome === "attested") {
    return c.json(
      failure("already_attested", "Attested evidence cannot gain a file.", [
        { path: "", message: "Record new evidence instead." },
      ]),
      409,
    );
  }
  return c.json(
    failure("too_many_files", `Evidence carries at most ${maxFilesPerEvidence} files.`, [
      { path: "", message: "Record separate evidence." },
    ]),
    409,
  );
};

const isEvidenceId = new RegExp(idPattern("evidence"));
const isFileId = new RegExp(idPattern("file"));

export function files(store: FileStore) {
  return new Hono<OrganizationEnv>()
    .post("/evidence/:evidenceId/files", async (c) => {
      const evidenceId = c.req.param("evidenceId");
      if (!isEvidenceId.test(evidenceId)) {
        return c.json(failure("not_found", "No such evidence."), 404);
      }
      const query = uploadQuery.safeParse(c.req.query());
      if (!query.success) return c.json(rejection("query", query.error), 400);
      const body = c.req.raw.body;
      if (!body) return c.json(failure("invalid_request", "The body is the file."), 400);

      // Checked before a byte is read, so an obviously oversized upload is
      // refused rather than streamed and then discarded. The real bound is the
      // one `put` counts.
      const declared = Number(c.req.header("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxFileBytes) {
        return c.json(failure("payload_too_large", "The file is too large."), 413);
      }

      // Asked before a byte is written: a request that was never going to be
      // kept should not cost a file's worth of writing first. Asked again,
      // under a lock, inside the transaction below, which is what decides.
      const ready = await c.var.withOrganization((tx) => evidenceState(tx, evidenceId));
      if (ready.outcome !== "ready") return refuse(c, ready.outcome);

      // Generated here so the bytes can be written before anything is promised
      // about them, and so the key never comes from a caller.
      const fileId = createId("file");
      let stored;
      try {
        stored = await store.put(fileId, body, maxFileBytes);
      } catch (error) {
        // `put` promises to leave nothing behind when it throws, so there is
        // nothing to clean up here.
        if (error instanceof TooManyBytes) {
          return c.json(failure("payload_too_large", "The file is too large."), 413);
        }
        throw error;
      }

      // `file_bytes_positive` refuses this, and a CHECK violation would be a
      // 500 for what is a client mistake. Only reachable with a chunked body:
      // a `content-length: 0` has no body at all and was refused above.
      if (stored.bytes === 0) {
        await store.discard(fileId);
        return c.json(failure("invalid_request", "The file is empty."), 400);
      }

      let result;
      try {
        result = await c.var.withOrganization(async (tx) => {
          const state = await evidenceState(tx, evidenceId, { lock: true });
          // A locked read is governed by the UPDATE policy, which sees only
          // unattested rows — so evidence attested since the check above is not
          // there to lock, and "cannot be locked" arrives as "does not exist".
          // Reading again without the lock is what tells 404 from 409.
          const settled = state.outcome === "missing" ? await evidenceState(tx, evidenceId) : state;
          if (settled.outcome !== "ready") return settled;

          // Under the lock above, so `file_evidence_open` agrees with what
          // was just decided. An insert either returns its row or raises.
          const row = await tx
            .insert(schema.file)
            .values({
              id: fileId,
              organizationId: c.var.member.organizationId,
              evidenceId,
              filename: query.data.filename,
              contentType: query.data.contentType ?? "application/octet-stream",
              bytes: stored.bytes,
              checksum: stored.checksum,
            })
            .returning()
            .then(([only]) => only!);

          // Attaching a file changes what the evidence *is* — its files are
          // part of how it reads back — so the evidence row is touched to say
          // so. Without this its version would not move, and a conditional
          // write could amend or discard evidence whose attachments the caller
          // never saw (ADR 0019). The event below already calls this an update
          // to the evidence; this makes the row agree.
          await tx
            .update(schema.evidence)
            .set({ updatedAt: new Date() })
            .where(eq(schema.evidence.id, evidenceId));

          await c.var.audit(tx, {
            action: "updated",
            resourceType: "evidence",
            resourceId: evidenceId,
            after: { attached: row.filename, bytes: row.bytes, checksum: row.checksum },
          });
          return { outcome: "attached", row } as const;
        });
      } catch (error) {
        // The row never landed, so nothing points at these bytes.
        await store.discard(fileId);
        throw error;
      }

      if (result.outcome !== "attached") {
        // Nobody's file: the bytes go too.
        await store.discard(fileId);
        return refuse(c, result.outcome);
      }

      return c.json({ data: result.row }, 201);
    })

    .get("/files/:fileId", async (c) => {
      const fileId = c.req.param("fileId");
      if (!isFileId.test(fileId)) return c.json(failure("not_found", "No such file."), 404);

      // Authorized from PostgreSQL, never from the storage location: a key is
      // not a permission, and knowing one must not be enough (DATA-01).
      const [row] = await c.var.withOrganization((tx) =>
        tx.select().from(schema.file).where(eq(schema.file.id, fileId)),
      );
      if (!row) return c.json(failure("not_found", "No such file."), 404);

      const bytes = await store.get(fileId);
      if (!bytes) {
        // The row is the authority on what exists, so this is storage having
        // lost something rather than the file not being there.
        return c.json(failure("internal", "The file's contents could not be read."), 500);
      }

      return new Response(bytes, {
        headers: {
          "content-type": row.contentType,
          "content-length": String(row.bytes),
          // Never inline: what a tenant uploaded is not this origin's to render.
          "content-disposition": `attachment; filename="${asciiName(row.filename)}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    });
}

/**
 * A filename safe to put in a header.
 *
 * `Content-Disposition` is a header, and a quote or a newline in one is a way
 * to write a header of your own. Anything outside plain printable ASCII becomes
 * an underscore; the real name is in the JSON, which has no such problem.
 */
const asciiName = (filename: string) =>
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
