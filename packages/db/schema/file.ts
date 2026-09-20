// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a file is. The bytes live in object storage, keyed by this row's id.
 *
 * PostgreSQL is the authority on whether a file exists, who it belongs to and
 * who may read it; the store knows only bytes under a key, and knowing a key is
 * not permission to read it (DATA-01). Reasoning:
 * `docs/adr/0013-durable-storage.md`, and
 * `docs/adr/0021-file-bytes-in-object-storage.md` for where the bytes went.
 */

import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import { createdAt, id, idFormat } from "./columns.ts";
import { evidence } from "./evidence.ts";

/**
 * `type/subtype`, and nothing after it.
 *
 * A conservative subset of RFC 9110's token: no quote, no backtick, and no
 * parameters. A parameter could not matter here — the stored object is served
 * as a generic attachment whatever this says, so nothing downstream would ever
 * interpret a `charset`.
 */
const mediaType = "^[A-Za-z0-9!#$%&*+.^_|~-]+/[A-Za-z0-9!#$%&*+.^_|~-]+$";

export const file = pgTable(
  "file",
  {
    id: id("file"),
    /**
     * Carried for the policies, and kept honest by the composite reference to
     * evidence rather than one of its own: evidence already names the
     * organization, and a file goes with its evidence.
     */
    organizationId: text("organization_id").notNull(),
    /** What it is attached to. Nothing here is a file on its own. */
    evidenceId: text("evidence_id").notNull(),
    /** What the uploader called it. For display; never a path (ADR 0013). */
    filename: text("filename").notNull(),
    /**
     * What the uploader said it is, kept as data rather than as a header.
     *
     * The stored object is served as `application/octet-stream`, so this is
     * what the API answers with and what a client decides how to read — never
     * what this origin offers a browser (ADR 0021).
     */
    contentType: text("content_type").notNull(),
    /**
     * How many bytes it is, counted from the stored object as it was hashed —
     * the same read, so the two describe one thing. Never a length a client
     * declared (ADR 0021).
     */
    bytes: integer("bytes").notNull(),
    /**
     * Lowercase hex SHA-256 of the bytes as stored.
     *
     * A bucket has no row-level security to lean on, so this is what makes a
     * change to the bytes of an attested record detectable rather than silent.
     * Computed by this server from the permanent object, never taken from a
     * client, and recomputed by `bun run verify:files` (ADR 0016).
     */
    checksum: text("checksum").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    idFormat("file", "file"),
    check("file_filename_present", sql`${table.filename} ~ '[^[:space:]]'`),
    // Bytes, not characters, for the reason `file_upload_filename_bytes` gives.
    check("file_filename_bytes", sql`octet_length(${table.filename}) <= 255`),
    /**
     * A media type, and only that.
     *
     * A file cannot be repaired: there is no UPDATE policy here, and no DELETE
     * policy to remove the row with either, so whatever lands is what the API
     * answers with for as long as the evidence exists. That is reason enough
     * for the shape to be a constraint rather than a rule the API is trusted
     * to remember — and `file_upload_content_type_shape` says the same thing a
     * step earlier, so a bad one is refused before the bytes are sent rather
     * than after (ADR 0021).
     */
    check("file_content_type_shape", sql.raw(`"content_type" ~ '${mediaType}'`)),
    check("file_bytes_positive", sql`${table.bytes} > 0`),
    check("file_checksum_is_sha256", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
    // What `file_upload` references, so an upload names a file of the evidence
    // it was prepared for, in its own organization. Redundant against the
    // primary key, and that is the point: carrying the other two columns makes
    // the relationship one the database checks rather than one the handler
    // merely gets right (TENANT-01). A constraint rather than a unique index,
    // for the reason `evidence` carries the same one (ADR 0008).
    unique("file_id_evidence_id_organization_id_key").on(
      table.id,
      table.evidenceId,
      table.organizationId,
    ),
    foreignKey({
      name: "file_evidence_fk",
      columns: [table.evidenceId, table.organizationId],
      foreignColumns: [evidence.id, evidence.organizationId],
    }).onDelete("cascade"),
    index("file_organization_id_evidence_id_created_at_id_idx").on(
      table.organizationId,
      table.evidenceId,
      table.createdAt,
      table.id,
    ),
  ],
);
