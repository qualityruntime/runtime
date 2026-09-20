// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File routes: authorizing an upload, recording what arrived, and handing back
 * a way to read it.
 *
 * No client transfer passes through here — both directions are short-lived
 * signed URLs, and a download is authorized from PostgreSQL before one is
 * issued, never from the storage location alone (DATA-01). The server makes
 * one read of its own, to measure what it is about to record.
 *
 * Reasoning: `docs/adr/0021-file-bytes-in-object-storage.md`.
 */

import { createId, idPattern, schema, type TenantTransaction } from "@qualityruntime/db";
import { eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { fileKey, measure, ObjectChanged, type ObjectStore, uploadKey } from "./objects.ts";
import type { OrganizationEnv } from "./organization.ts";
import { failure } from "./responses.ts";
import { jsonBody, words } from "./validation.ts";

/**
 * The largest file this accepts.
 *
 * Generous for the minutes, screenshots, SBOMs and exports evidence is made of.
 * Checked three times: against a declared size before a URL is issued, against
 * the staged object before it is copied, and against the permanent object,
 * which is the one that decides.
 */
export const maxFileBytes = 25 * 1024 * 1024;

/** How many files one piece of evidence may carry. */
export const maxFilesPerEvidence = 20;

/**
 * A filename, bounded in bytes and required to be well-formed.
 *
 * Bytes because promotion writes it into `Content-Disposition` twice, ASCII
 * and percent-encoded, and AWS counts that header against a 2 KiB metadata
 * budget — so 255 *characters* of CJK is a copy S3 refuses after the upload
 * has been paid for. Well-formed because a lone surrogate survives
 * `JSON.parse` and then makes `encodeURIComponent` throw at promotion.
 *
 * `file_upload_filename_bytes` is the database's half of the first rule.
 */
const maxFilenameBytes = 255;
const filename = words(maxFilenameBytes)
  .refine((value) => new TextEncoder().encode(value).length <= maxFilenameBytes, {
    message: `Must be at most ${maxFilenameBytes} bytes once encoded as UTF-8.`,
  })
  .refine((value) => !/\p{Surrogate}/u.test(value), {
    message: "Must be well-formed Unicode.",
  })
  .meta({
    description:
      `At most ${maxFilenameBytes} bytes as UTF-8, so a name of non-Latin characters is ` +
      `shorter than ${maxFilenameBytes} of them. Surrounding whitespace is removed once the ` +
      `length is checked.`,
  });

/**
 * How long a prepared upload lasts, in seconds. Long enough for a slow link to
 * finish 25 MiB and still complete; short enough that abandoned bytes are
 * reclaimable soon after.
 *
 * One number, spent twice: the completion window, and the life of the URL
 * signed just afterwards. The URL therefore outlives `expires_at` by the width
 * of that gap, harmlessly — a late PUT lands on a key no completion can claim.
 * The deadline that binds is the completion one, and the database keeps it.
 */
export const uploadWindow = 15 * 60;

/** How long a download URL lasts, in seconds. Long enough to follow, and no more. */
const downloadWindow = 60;

/**
 * A media type, checked to be one, because it is copied onto the `file` row
 * where it cannot be repaired: `file` has no UPDATE policy. `type/subtype` and
 * nothing after it — the object is served as a generic attachment, so nothing
 * downstream would read a `charset`.
 *
 * A pattern rather than a refinement, so it survives into the published schema
 * (ADR 0007). `file_upload_content_type_shape` is the guarantee behind it.
 */
const token = "[A-Za-z0-9!#$%&*+.^_|~-]+";
const mediaType = new RegExp(`^${token}/${token}$`);

/**
 * What a client says about the file it is about to upload.
 *
 * Strict: a misspelt `contentType` would otherwise store the default for good,
 * since an attached file cannot be changed.
 */
export const prepareUploadBody = z.strictObject({
  filename,
  contentType: z
    .string()
    .max(255)
    .regex(mediaType, "Must be a media type, such as application/pdf.")
    .optional(),
  bytes: z
    .int()
    .positive()
    .optional()
    .meta({
      description:
        `How large the file is, if known. Optional, and never recorded: it buys an early ` +
        `refusal for a file over ${maxFileBytes} bytes, and the size that is recorded is ` +
        `measured from what the store ends up holding.`,
    }),
});

export const fileUploadResponse = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  evidenceId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  expiresAt: z.iso.datetime().meta({
    description:
      "The completion deadline. After this the upload can no longer be completed — " +
      "including by a completion that began before it and was still checking the bytes. " +
      "Prepare another upload and send the file again. The URL below is separately " +
      "short-lived and is not worth keeping either way.",
  }),
  upload: z.strictObject({
    method: z.literal("PUT"),
    url: z.string().meta({
      description:
        "Send the bytes here with a single PUT, then complete the upload. Carries its own " +
        "authorization, so no session or header is needed — and is not a URL to keep.",
    }),
  }),
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
 * Why evidence may not gain a file, or that it may.
 *
 * A union rather than one object, so that ruling `ready` out leaves exactly
 * the three `refuse` knows how to answer.
 */
type EvidenceState =
  | { outcome: "missing" }
  | { outcome: "attested" }
  | { outcome: "too_many" }
  | { outcome: "ready" };

/**
 * Whether evidence is here, visible, and still open to attachments. Both
 * writers lock it while they decide, at different strengths.
 *
 * `no key update` is a completion's, and is the lock `file_evidence_open`
 * takes on insert, taken earlier so this decision stays true until then. It
 * conflicts with another attachment's, so two completions cannot both count
 * the same room and use it. Not `for share`, which does not conflict with
 * itself: this handler goes on to update the evidence row, so two attachments
 * would each wait on the other's update and deadlock.
 *
 * `key share` is preparing's, and the weakest lock that does its job. It
 * conflicts only with the `for update` a discard holds, so the evidence cannot
 * vanish between this read and the `file_upload` insert that references it —
 * which would be a foreign key violation where a 404 belongs. It reserves no
 * slot, delays no completion, and stands in no attestation's way: it is the
 * lock the foreign key takes anyway, taken before the decision rather than
 * during it.
 */
async function evidenceState(
  tx: TenantTransaction,
  evidenceId: string,
  { lock }: { lock?: "key share" | "no key update" } = {},
): Promise<EvidenceState> {
  const asked = tx
    .select({ id: schema.evidence.id, attestedAt: schema.evidence.attestedAt })
    .from(schema.evidence)
    .where(eq(schema.evidence.id, evidenceId));
  const [evidence] = await (lock ? asked.for(lock) : asked);
  // A locked read is governed by the UPDATE policy, which sees only unattested
  // rows — so evidence attested since is not there to lock, and "cannot be
  // locked" arrives as "does not exist". Reading again without the lock is
  // what tells a 404 from a 409.
  if (!evidence) return lock ? evidenceState(tx, evidenceId) : ({ outcome: "missing" } as const);
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
const isUploadId = new RegExp(idPattern("fileUpload"));

const noSuchUpload = (c: Context) => c.json(failure("not_found", "No such upload."), 404);

/**
 * Removes bytes nothing will claim, and never changes the answer.
 *
 * Every removal here tidies after a decision already made, so a store that
 * refuses one must not turn a 413 into a 500 or replace the database error
 * that explains the failure. Quiet is affordable because what is left is
 * unreferenced by construction, which is what `reclaim:storage` looks for.
 */
const discardQuietly = (store: ObjectStore, key: string) =>
  store.discard(key).catch(() => undefined);

export function files(store: ObjectStore) {
  return new Hono<OrganizationEnv>()
    .post("/evidence/:evidenceId/file-uploads", jsonBody(prepareUploadBody), async (c) => {
      const evidenceId = c.req.param("evidenceId");
      if (!isEvidenceId.test(evidenceId)) {
        return c.json(failure("not_found", "No such evidence."), 404);
      }
      const { filename, contentType, bytes } = c.req.valid("json");

      // Refused before a URL exists, so an upload that could never be kept
      // costs the bucket nothing. A caller that declares nothing, or lies,
      // meets the same bound at completion against what the store holds.
      if (bytes !== undefined && bytes > maxFileBytes) {
        return c.json(failure("payload_too_large", "The file is too large."), 413);
      }

      const prepared = await c.var.withOrganization(async (tx) => {
        // Locked only against disappearing. This reserves nothing: evidence
        // attested between here and the completion refuses the completion,
        // which is the intended outcome, and it is the insert into `file` that
        // decides (ADR 0021).
        const state = await evidenceState(tx, evidenceId, { lock: "key share" });
        if (state.outcome !== "ready") return state;

        const [row] = await tx
          .insert(schema.fileUpload)
          .values({
            organizationId: c.var.member.organizationId,
            evidenceId,
            filename,
            contentType: contentType ?? "application/octet-stream",
            // Set by the database, for the reason `uploadWithFile` reads it
            // back from there: this deadline is PostgreSQL's to keep.
            expiresAt: sql`clock_timestamp() + ${uploadWindow} * interval '1 second'`,
          })
          .returning();
        return { outcome: "prepared", row: row! } as const;
      });
      if (prepared.outcome !== "prepared") return refuse(c, prepared.outcome);

      // Only ever for the temporary key. No permanent object is signed for
      // writing, so a URL that outlives its usefulness cannot reach one.
      const upload = await store.signedUpload(uploadKey(prepared.row.id), {
        expiresIn: uploadWindow,
      });
      // Named rather than spread: what this answers with is the contract, not
      // whatever columns the table happens to carry.
      const intent = prepared.row;
      return c.json(
        {
          data: {
            id: intent.id,
            organizationId: intent.organizationId,
            evidenceId: intent.evidenceId,
            filename: intent.filename,
            contentType: intent.contentType,
            expiresAt: intent.expiresAt,
            upload,
          },
        },
        201,
      );
    })

    .put("/file-uploads/:uploadId/completion", async (c) => {
      const uploadId = c.req.param("uploadId");
      if (!isUploadId.test(uploadId)) return noSuchUpload(c);

      const intent = await c.var.withOrganization(async (tx) => {
        const row = await uploadWithFile(tx, uploadId);
        if (!row) return { outcome: "missing" } as const;
        // Already completed: the same answer as the first time, without
        // touching the store. This is what makes a retry safe after a lost
        // response, and the upload identifier is the key the client already has.
        if (row.file) return { outcome: "completed", file: row.file } as const;
        if (row.expired) return { outcome: "expired" } as const;
        return { outcome: "open", row: row.upload } as const;
      });

      if (intent.outcome === "missing") return noSuchUpload(c);
      if (intent.outcome === "completed") return c.json({ data: intent.file }, 200);
      if (intent.outcome === "expired") return uploadExpired(c);

      // Everything below talks to the object store, and none of it holds a
      // database transaction open while it does (ADR 0021).
      const temporary = uploadKey(uploadId);
      const staged = await store.inspect(temporary);
      if (!staged) {
        return (
          (await settledMeanwhile(c, uploadId)) ??
          c.json(
            failure("no_bytes", "Nothing was uploaded.", [
              { path: "", message: "Send the bytes to the signed URL first." },
            ]),
            409,
          )
        );
      }
      // A first look, to refuse the obvious before a copy is paid for. What
      // the row records is measured from the permanent object below.
      const tooLarge = staged.bytes > maxFileBytes;
      if (staged.bytes === 0 || tooLarge) {
        await discardQuietly(store, temporary);
        return (
          (await settledMeanwhile(c, uploadId)) ??
          (tooLarge
            ? c.json(failure("payload_too_large", "The file is too large."), 413)
            : c.json(failure("invalid_request", "The file is empty."), 400))
        );
      }

      // Promote first, then measure what was promoted — never the staged
      // object. A client writes headers as well as bytes, and
      // `Content-Encoding: gzip` on the PUT is stored as metadata, returned on
      // the GET, and decompressed by `fetch`; the copy moves the stored bytes
      // and leaves the encoding behind. Hashing the staged object would
      // therefore record a checksum of bytes nobody keeps, and the first
      // `verify:files` would call a new file altered. The entity tag is no
      // help — S3 says it reflects content, not metadata.
      //
      // The permanent object has none of that: it is never presigned for
      // writing, and promotion replaces the metadata with this server's own.
      // The cost is that a failed measurement leaves an object no row names,
      // which is an orphan `reclaim:storage` can find — where the alternative
      // was a checksum nothing can reconcile with its own bytes (ADR 0021).
      const fileId = createId("file");
      const permanent = fileKey(fileId);
      let promoted;
      try {
        promoted = await store.promote(temporary, permanent, {
          matching: staged.entityTag,
          filename: intent.row.filename,
        });
      } catch (error) {
        if (error instanceof ObjectChanged) {
          return (await settledMeanwhile(c, uploadId)) ?? uploadChanged(c);
        }
        throw error;
      }

      let measured;
      try {
        // Pinned to what the copy produced: the copy and this read are two
        // operations, and anything with write access to the bucket could
        // otherwise slip bytes in between them and have them become the
        // baseline rather than be caught by it.
        const written = await store.read(permanent, { matching: promoted.entityTag });
        if (!written) throw new Error(`${permanent} was promoted and is not there.`);
        measured = await measure(written);
      } catch (error) {
        await discardQuietly(store, permanent);
        throw error;
      }

      // Against what was written, which is what the row will claim. This and
      // the staged size agree unless the object carried an encoding.
      if (measured.bytes === 0 || measured.bytes > maxFileBytes) {
        await discardQuietly(store, permanent);
        await discardQuietly(store, temporary);
        return (
          (await settledMeanwhile(c, uploadId)) ??
          (measured.bytes === 0
            ? c.json(failure("invalid_request", "The file is empty."), 400)
            : c.json(failure("payload_too_large", "The file is too large."), 413))
        );
      }

      let result;
      try {
        result = await c.var.withOrganization(async (tx) => {
          // Evidence first, upload second, and that order is load-bearing: a
          // discard takes `for update` on the evidence and cascades into
          // `file_upload`, so a completion holding the upload while it waited
          // for the evidence is the other half of a deadlock —
          // `concurrency.test.ts` finds it in about a second.
          //
          // Which evidence comes from the intent read before the storage work,
          // which is sound because nothing may move an upload's `evidence_id`:
          // the runtime holds `UPDATE` on `file_id` alone.
          const state = await evidenceState(tx, intent.row.evidenceId, {
            lock: "no key update",
          });

          // Then the upload, so two completions of one are decided here rather
          // than by which insert lands first. `file_upload_tenant_complete`
          // governs the lock and admits only an unclaimed upload whose window
          // is still open — and the storage work above can outlast one.
          const [open] = await tx
            .select()
            .from(schema.fileUpload)
            .where(eq(schema.fileUpload.id, uploadId))
            .for("update");
          if (!open) {
            // A row that would not lock failed one of those tests or is not
            // there at all; the read policy applies neither, so it tells which.
            const settled = await uploadWithFile(tx, uploadId);
            // Gone entirely: the evidence was discarded while this uploaded,
            // and the upload cascaded with it.
            if (!settled) return { outcome: "gone" } as const;
            if (settled.file) return { outcome: "lost", file: settled.file } as const;
            return { outcome: "expired" } as const;
          }

          // Asked before the evidence is judged, because losing the race is
          // the better answer: the winner's file exists either way.
          if (state.outcome !== "ready") return state;

          // Under the lock above, so `file_evidence_open` agrees with what was
          // just decided. An insert either returns its row or raises.
          const row = await tx
            .insert(schema.file)
            .values({
              id: fileId,
              organizationId: c.var.member.organizationId,
              evidenceId: open.evidenceId,
              filename: open.filename,
              contentType: open.contentType,
              bytes: measured.bytes,
              checksum: measured.checksum,
            })
            .returning()
            .then(([only]) => only!);

          // The row count is the point. This statement is governed by the
          // same wall-clock policy the lock above was, re-evaluated now — so
          // the window can close between the two, and an update that matched
          // nothing would otherwise leave a `file` its upload does not claim,
          // and a retry told its window closed rather than given the file it
          // already produced. Nothing else can make this miss: the row is
          // locked, so no other completion can claim it first.
          const claimed = await tx
            .update(schema.fileUpload)
            .set({ fileId: row.id })
            .where(eq(schema.fileUpload.id, uploadId))
            .returning({ id: schema.fileUpload.id });
          if (claimed.length === 0) throw new UploadWindowClosed();

          // Attaching a file changes what the evidence *is* — its files are
          // part of how it reads back — so the evidence row is touched to say
          // so. Without this its version would not move, and a conditional
          // write could amend or discard evidence whose attachments the caller
          // never saw (ADR 0019).
          await tx
            .update(schema.evidence)
            .set({ updatedAt: new Date() })
            .where(eq(schema.evidence.id, open.evidenceId));

          await c.var.audit(tx, {
            action: "updated",
            resourceType: "evidence",
            resourceId: open.evidenceId,
            // Identified as the discard event identifies it: filenames repeat
            // legally, and the identifier is also the storage key.
            after: {
              attached: {
                id: row.id,
                filename: row.filename,
                contentType: row.contentType,
                bytes: row.bytes,
                checksum: row.checksum,
              },
            },
          });
          return { outcome: "attached", row } as const;
        });
      } catch (error) {
        // Thrown by the callback rather than by the server, so its rollback is
        // certain: the `file` row went with it, and both keys are this
        // attempt's to clean up.
        if (error instanceof UploadWindowClosed) {
          await discardQuietly(store, permanent);
          await discardQuietly(store, temporary);
          return uploadExpired(c);
        }
        // Anything else was not anticipated here, and a driver error does not
        // say whether the commit was made durable before it arrived. So the
        // promoted object stays: an orphan `reclaim:storage` can find, where
        // deleting it would take bytes a committed row may name (ADR 0021).
        throw error;
      }

      if (result.outcome !== "attached") {
        // Neither key is anybody's now. The permanent object is this attempt's
        // alone and no row will ever name it; the temporary one has no
        // completion left that could use it, because every outcome here is
        // final — the race is decided, or the evidence is attested, full or
        // gone. Losing a race is no exception: the winner's `file_id` is
        // committed, so it is past its own storage work, and `discard` does
        // not mind being asked twice.
        await discardQuietly(store, permanent);
        await discardQuietly(store, temporary);

        if (result.outcome === "lost") return c.json({ data: result.file }, 200);
        if (result.outcome === "gone") return noSuchUpload(c);
        if (result.outcome === "expired") return uploadExpired(c);
        return refuse(c, result.outcome);
      }

      // The bytes are safe under their permanent key, so the temporary copy is
      // finished with.
      await discardQuietly(store, temporary);

      return c.json({ data: result.row }, 200);
    })

    .get("/files/:fileId", async (c) => {
      const fileId = c.req.param("fileId");
      if (!isFileId.test(fileId)) return c.json(failure("not_found", "No such file."), 404);

      // Authorized from PostgreSQL, never from the storage location: a key is
      // not a permission, and knowing one must not be enough (DATA-01). Only
      // then is anything signed.
      const [row] = await c.var.withOrganization((tx) =>
        tx.select().from(schema.file).where(eq(schema.file.id, fileId)),
      );
      if (!row) return c.json(failure("not_found", "No such file."), 404);

      const url = await store.signedDownload(fileKey(fileId), { expiresIn: downloadWindow });
      return new Response(null, {
        status: 303,
        headers: {
          location: url,
          // The URL carries its own authorization for a minute: not something
          // to cache, and not something to hand to the next origin.
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    });
}

/**
 * An upload and the file it produced, read as one statement.
 *
 * Two statements are two snapshots under `read committed`, and discarding
 * evidence takes the upload and the file together — so a read that found the
 * completed upload first could find no file second, and answer 200 with
 * nothing in it. One join is one snapshot: both rows or neither.
 */
async function uploadWithFile(tx: TenantTransaction, uploadId: string) {
  const [row] = await tx
    .select({
      upload: schema.fileUpload,
      file: schema.file,
      // On the database's clock, because `file_upload_tenant_complete` is what
      // decides and judges by `clock_timestamp()`. A handler's own `Date.now()`
      // would disagree by whatever the skew is, which on a Worker talking to a
      // managed PostgreSQL is not nothing.
      expired: sql<boolean>`${schema.fileUpload.expiresAt} <= clock_timestamp()`,
    })
    .from(schema.fileUpload)
    .leftJoin(schema.file, eq(schema.file.id, schema.fileUpload.fileId))
    .where(eq(schema.fileUpload.id, uploadId));
  return row;
}

/**
 * What became of an upload while this attempt was talking to the store: gone,
 * completed by somebody else, out of time, or none of those — and then the
 * store's own refusal stands.
 *
 * Every refusal derived from the store is ambiguous while a second completion
 * of the same upload may be running, because the winner removes the temporary
 * object as it commits: "nothing was uploaded" and "the bytes changed" are
 * both shapes winning takes, seen from the attempt that lost. A retry sent
 * because the first response was slow is exactly that race, and a 409 would
 * break the idempotency the upload identifier exists to give.
 *
 * Asked only where this is about to refuse, so the common path pays nothing.
 */
async function settledMeanwhile(c: Context<OrganizationEnv>, uploadId: string) {
  const row = await c.var.withOrganization((tx) => uploadWithFile(tx, uploadId));
  if (!row) return noSuchUpload(c);
  if (row.file) return c.json({ data: row.file }, 200);
  // The advertised deadline binds a completion that began in time, so a
  // refusal about the store would be about the wrong thing — and would invite
  // a retry the database will not accept either.
  if (row.expired) return uploadExpired(c);
  return undefined;
}

/**
 * Thrown when the window closed between locking the upload and claiming it.
 *
 * The policy is re-evaluated per statement against the wall clock, so holding
 * the lock does not guarantee the update after it matches. Rolling back is
 * what keeps the `file` row and the claim on the upload together.
 */
class UploadWindowClosed extends Error {}

/** The window closed. Answered before the storage work and again after it,
 * which a 25 MiB copy and read can outlast. */
const uploadExpired = (c: Context) =>
  c.json(
    failure("upload_expired", "The upload window has closed.", [
      { path: "", message: "Prepare another upload." },
    ]),
    410,
  );

const uploadChanged = (c: Context) =>
  c.json(
    failure("upload_changed", "The uploaded bytes changed while they were being checked.", [
      { path: "", message: "Prepare another upload and send the file once." },
    ]),
    409,
  );
