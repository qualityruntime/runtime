// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a file is. The bytes live in durable storage, keyed by this row's id.
 *
 * PostgreSQL is the authority on whether a file exists, who it belongs to and
 * who may read it; storage knows only bytes under a key (DATA-01). Reasoning:
 * `docs/adr/0013-durable-storage.md`.
 */

import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id, idFormat } from "./columns.ts";
import { evidence } from "./evidence.ts";

/**
 * `type/subtype`, and nothing after it.
 *
 * A conservative subset of RFC 9110's token: no quote, no backtick, and no
 * parameters. A parameter could not matter here — every file is served as an
 * attachment with `nosniff`, so nothing ever interprets a `charset`.
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
    /** What the uploader said it is. For a `Content-Type` on the way back. */
    contentType: text("content_type").notNull(),
    /** Counted while writing, not taken from a header. */
    bytes: integer("bytes").notNull(),
    /**
     * Lowercase hex SHA-256 of the bytes as stored.
     *
     * Storage has no row-level security to lean on, so this is what makes a
     * change to the bytes of an attested record detectable rather than silent.
     */
    checksum: text("checksum").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    idFormat("file", "file"),
    check("file_filename_present", sql`${table.filename} ~ '[^[:space:]]'`),
    /**
     * A media type, and only that.
     *
     * This value is written into a `Content-Type` header when the file is read
     * back. A newline in one is a way to write a header of your own, and a
     * value the runtime refuses to put in a header at all makes the file
     * permanently unreadable: there is no UPDATE policy here, and no DELETE
     * policy to remove the row with either. So the shape is a
     * constraint rather than a rule the API is trusted to remember.
     */
    check("file_content_type_shape", sql.raw(`"content_type" ~ '${mediaType}'`)),
    check("file_bytes_positive", sql`${table.bytes} > 0`),
    check("file_checksum_is_sha256", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
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
