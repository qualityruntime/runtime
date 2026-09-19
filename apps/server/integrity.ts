// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checking that stored bytes are still the bytes that were stored.
 *
 * Every other guarantee here is one PostgreSQL enforces. A volume has no
 * policies: whatever can write to it can change what an attested record's file
 * says, and the row would go on describing the file it used to be. The checksum
 * `file` carries makes that detectable (ADR 0013); this is what detects it.
 *
 * Not a route. Reading every byte an organization holds is not something to do
 * inside a request, and this takes a database handle and a store rather than a
 * Hono context, so anything may call it — a command today, a scheduled job when
 * there is one.
 */

import { type Database, schema, withOrganization } from "@qualityruntime/db";
import { asc } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { checksumOf, type FileStore } from "./storage.ts";

/** What was wrong with one file, if anything was. */
export type Finding = {
  fileId: string;
  organizationId: string;
  evidenceId: string;
  filename: string;
  /**
   * `missing`: storage has no bytes. `altered`: it has different ones.
   * `unreadable`: there is something there, but reading it failed.
   */
  fault: "missing" | "altered" | "unreadable";
  /** What the row says the bytes hash to. */
  expected: string;
  /** What they actually hash to, where they could be read. */
  found?: string;
  /** Why an `unreadable` file could not be read. */
  detail?: string;
};

export type Verification = { checked: number; findings: Finding[] };

/** A handle that is not already a transaction, which is what this starts from. */
type Handle<Q extends PgQueryResultHKT> = Database<Q> & { rollback?: never };

/**
 * Verifies every file one organization holds.
 *
 * Reads inside a tenant context, so the rows it sees are that organization's
 * and nothing else — the same boundary every other read crosses (ADR 0003).
 */
export async function verifyOrganization<Q extends PgQueryResultHKT>(
  db: Handle<Q>,
  store: FileStore,
  organizationId: string,
): Promise<Verification> {
  const rows = await withOrganization(db, organizationId, (tx) =>
    tx.select().from(schema.file).orderBy(asc(schema.file.createdAt), asc(schema.file.id)),
  );

  const findings: Finding[] = [];
  for (const row of rows) {
    // One at a time, on purpose: this reads every byte an organization holds,
    // and doing that as fast as possible is no kindness to a running server.
    const identity = {
      fileId: row.id,
      organizationId: row.organizationId,
      evidenceId: row.evidenceId,
      filename: row.filename,
      expected: row.checksum,
    };

    // A file that cannot be read is a finding, not an exception. One
    // unreadable file must not discard the tampering already found in the
    // files before it — a report that stops at the first fault is the one
    // thing this command cannot afford to produce.
    let found: string;
    try {
      const bytes = await store.get(row.id);
      if (!bytes) {
        findings.push({ ...identity, fault: "missing" });
        continue;
      }
      found = await checksumOf(bytes);
    } catch (error) {
      findings.push({ ...identity, fault: "unreadable", detail: String(error) });
      continue;
    }

    if (found !== row.checksum) findings.push({ ...identity, fault: "altered", found });
  }

  return { checked: rows.length, findings };
}

/**
 * Verifies every file every organization holds.
 *
 * `organization` is Better Auth's table and carries no policy, so the list is
 * readable here; each organization's files are then read inside its own
 * context rather than by reaching across them.
 */
export async function verifyEverything<Q extends PgQueryResultHKT>(
  db: Handle<Q>,
  store: FileStore,
): Promise<Verification> {
  const organizations = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .orderBy(asc(schema.organization.id));

  const combined: Verification = { checked: 0, findings: [] };
  for (const { id } of organizations) {
    const result = await verifyOrganization(db, store, id);
    combined.checked += result.checked;
    combined.findings.push(...result.findings);
  }
  return combined;
}

/** What a person running this needs to read, in the order they need it. */
export function describeVerification({ checked, findings }: Verification): string {
  // Not "all match": a check of nothing is not a pass, and pointed at the wrong
  // database — a restore that never loaded, a fresh one — it would read as one.
  // Still exit 0, because a new deployment really does hold no files.
  if (checked === 0) {
    return [
      "No files are recorded, so nothing was checked.",
      "If some should be, check that DATABASE_URL names the right database.",
    ].join("\n");
  }
  if (findings.length === 0) return `Checked ${checked} file(s). All match what was recorded.`;

  const lines = findings.map((finding) => {
    const where = `${finding.fileId}  ${finding.filename}  (evidence ${finding.evidenceId})`;
    switch (finding.fault) {
      case "missing":
        return `  MISSING     ${where}`;
      case "unreadable":
        return `  UNREADABLE  ${where}\n              ${finding.detail}`;
      case "altered":
        return (
          `  ALTERED     ${where}\n` +
          `              recorded ${finding.expected}\n              found    ${finding.found}`
        );
    }
  });

  // Every fault below has the same first question — what wrote to the volume —
  // except that a volume which is not there at all looks exactly like every
  // file being gone, and that is the cheaper thing to rule out first.
  const allMissing = findings.length === checked && findings.every((f) => f.fault === "missing");
  return [
    `Checked ${checked} file(s). ${findings.length} did not match what was recorded:`,
    ...lines,
    "",
    ...(allMissing
      ? [
          "Every file is gone, which is what an unmounted or misconfigured volume",
          "also looks like. Check STORAGE_DIRECTORY before concluding anything.",
        ]
      : [
          "A file that does not match what was recorded has changed since it was stored.",
          "Nothing in this product can do that, so something else did.",
        ]),
  ].join("\n");
}
