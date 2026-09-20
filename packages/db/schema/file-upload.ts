// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An upload intent: permission to attempt an upload, and nothing more.
 *
 * Bytes go from the client straight to object storage, so something has to
 * survive between "you may upload" and "here is what arrived". Deliberately
 * not a `file` row in a pending state: a `file` describes bytes already
 * written, cannot be updated or deleted by the runtime role, and belongs to
 * evidence whose attachments are final once attested. None of that is true of
 * an upload that may never happen.
 *
 * So this is infrastructure state rather than a quality record — the runtime's
 * to change and reclaim, and in no history, because nothing here is evidence
 * of anything until a `file` row exists. Open and expired intents are
 * temporary; a completed one is kept as the receipt that makes a retry
 * idempotent.
 *
 * Reasoning: `docs/adr/0021-file-bytes-in-object-storage.md`.
 */

import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createdAt, id, idFormat } from "./columns.ts";
import { evidence } from "./evidence.ts";
import { file } from "./file.ts";

export const fileUpload = pgTable(
  "file_upload",
  {
    id: id("fileUpload"),
    /** Carried for the policies, and kept honest by the composite references. */
    organizationId: text("organization_id").notNull(),
    /**
     * What the file will attach to, if the upload is ever completed.
     *
     * Naming evidence here reserves nothing: whether it may gain a file is
     * decided at the `file` insert, under the lock `file_evidence_open` takes.
     * Evidence attested after this row was written refuses the completion,
     * which is the intended outcome.
     */
    evidenceId: text("evidence_id").notNull(),
    /** What the file will be called. Settled here so the stored object can be
     * given its `Content-Disposition` at promotion time. */
    filename: text("filename").notNull(),
    /** What the file will say it is. Never what the client sent the bytes as. */
    contentType: text("content_type").notNull(),
    /**
     * When the right to complete this upload runs out — the deadline that
     * binds, as against the signed URL's own, which outlives it by a moment.
     *
     * A completion refused past this is what lets an expired row be reclaimed
     * without racing one that would still have succeeded.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * The file this upload became, once it became one. Null until then.
     *
     * Also the record that makes completion idempotent: a retry after a lost
     * response finds this set and answers with the same file rather than
     * attaching a second one. So a completed upload's row is kept, and the
     * policies refuse to reclaim it.
     *
     * And the only column the runtime holds `UPDATE` on: the completion
     * handler decides from values it read before spending minutes in the
     * object store, so nothing above may move (`docs/deployment.md`).
     */
    fileId: text("file_id"),
    createdAt: createdAt(),
  },
  (table) => [
    idFormat("file_upload", "fileUpload"),
    // Both are copied onto the `file` row at completion, where they can no
    // longer be repaired, so they are refused here rather than there.
    check("file_upload_filename_present", sql`${table.filename} ~ '[^[:space:]]'`),
    // Bytes, not characters: the name is copied into `Content-Disposition`
    // twice at promotion — plain and percent-encoded — and AWS counts that
    // header against a 2 KiB metadata budget (ADR 0021).
    check("file_upload_filename_bytes", sql`octet_length(${table.filename}) <= 255`),
    check(
      "file_upload_content_type_shape",
      sql.raw(`"content_type" ~ '^[A-Za-z0-9!#$%&*+.^_|~-]+/[A-Za-z0-9!#$%&*+.^_|~-]+$'`),
    ),
    /**
     * The evidence it is destined for, and the tenant boundary in one
     * constraint. Cascading, as `file` does: an upload for evidence that has
     * been discarded is for nothing.
     */
    foreignKey({
      name: "file_upload_evidence_fk",
      columns: [table.evidenceId, table.organizationId],
      foreignColumns: [evidence.id, evidence.organizationId],
    }).onDelete("cascade"),
    /**
     * The file it produced: this organization's own, and attached to the very
     * evidence this upload was prepared for.
     *
     * Composite for the reason every reference here is, one column wider. A
     * cross-tenant link must be impossible rather than merely unwritten
     * (TENANT-01), and so must a link to the right tenant's wrong evidence —
     * which is what a retry would then answer with. The cascade is unreachable
     * in practice, and is there so no route to removing a file leaves a row
     * naming one.
     */
    foreignKey({
      name: "file_upload_file_fk",
      columns: [table.fileId, table.evidenceId, table.organizationId],
      foreignColumns: [file.id, file.evidenceId, file.organizationId],
    }).onDelete("cascade"),
    // One upload produces at most one file, and one file comes from at most one
    // upload. Nulls do not collide, so uncompleted uploads are unaffected.
    unique("file_upload_file_id_key").on(table.fileId),
    // What a sweep for abandoned uploads reads. Partial, because a completed
    // upload is never swept and the rows worth scanning are the minority.
    index("file_upload_organization_id_expires_at_idx")
      .on(table.organizationId, table.expiresAt)
      .where(sql`${table.fileId} is null`),
    // Discarding evidence cascades into this table, and a referential action
    // with no index to use reads all of it. The partial index above cannot
    // serve that: it excludes exactly the completed rows a cascade must find.
    index("file_upload_evidence_id_organization_id_idx").on(table.evidenceId, table.organizationId),
  ],
);
