// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checking that stored bytes are still the bytes that were stored.
 *
 * Every other guarantee here is one PostgreSQL enforces. A bucket has no
 * policies of this kind: whatever can write to it can change what an attested
 * record's file says, and the row would go on describing the file it used to
 * be. The checksum `file` carries makes that detectable (ADR 0013); this is
 * what detects it.
 *
 * Not a route: reading every byte an organization holds is not something to do
 * inside a request. It takes a database handle and a store rather than a Hono
 * context, so anything may call it.
 */

import { type Database, schema, withOrganization } from "@qualityruntime/db";
import { asc } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { fileKey, measure, ObjectChanged, type ObjectStore } from "./objects.ts";

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
  /** What the row says the bytes hash to, and how many of them there are. */
  expected: string;
  expectedBytes?: number;
  /** What they actually hash to, where they could be read. */
  found?: string;
  /** How many the store holds, where that is what disagreed. */
  foundBytes?: number;
  /** Why an `unreadable` file could not be read, or how an `altered` one moved. */
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
  store: ObjectStore,
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

    // The size first, from `HEAD`. It is the other half of what the row
    // records about the bytes and was previously never checked — so a wrong
    // `bytes` column went unreported, and proving that a 10-byte file had
    // become a 25 MiB one cost reading all 25 MiB. A size that already
    // disagrees settles the question.
    let seen;
    try {
      seen = await store.inspect(fileKey(row.id));
    } catch (error) {
      findings.push({ ...identity, fault: "unreadable", detail: String(error) });
      continue;
    }
    if (!seen) {
      findings.push({ ...identity, fault: "missing" });
      continue;
    }
    if (seen.bytes !== row.bytes) {
      findings.push({
        ...identity,
        fault: "altered",
        expectedBytes: row.bytes,
        foundBytes: seen.bytes,
      });
      continue;
    }

    // A file that cannot be read is a finding, not an exception. One
    // unreadable file must not discard the tampering already found in the
    // files before it — a report that stops at the first fault is the one
    // thing this command cannot afford to produce.
    let found: { checksum: string; bytes: number };
    try {
      // The content that was sized, not whatever is there when the read
      // starts. Without the precondition this could report a checksum of one
      // object against the size of another and call the pair sound.
      const bytes = await store.read(fileKey(row.id), { matching: seen.entityTag });
      if (!bytes) {
        findings.push({ ...identity, fault: "missing" });
        continue;
      }
      found = await measure(bytes);
    } catch (error) {
      // Changed under the check: a finding, and the plainest kind. Reporting
      // it as unreadable would send an operator looking at credentials.
      if (error instanceof ObjectChanged) {
        findings.push({
          ...identity,
          fault: "altered",
          detail: "The object changed while it was being checked.",
        });
        continue;
      }
      findings.push({ ...identity, fault: "unreadable", detail: String(error) });
      continue;
    }

    // Both halves of what was read, against both halves of what was recorded.
    // The `HEAD` above is a cheap first check and describes whatever
    // representation the store chose to answer it with; this describes the
    // bytes actually consumed, which is what the row claims.
    if (found.checksum !== row.checksum || found.bytes !== row.bytes) {
      findings.push({
        ...identity,
        fault: "altered",
        found: found.checksum,
        ...(found.bytes === row.bytes ? {} : { expectedBytes: row.bytes, foundBytes: found.bytes }),
      });
    }
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
  store: ObjectStore,
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
        // Whichever half disagreed. A size that is already wrong is reported
        // without a checksum, because the bytes were never read.
        if (finding.detail) return `  ALTERED     ${where}\n              ${finding.detail}`;
        return finding.foundBytes === undefined
          ? `  ALTERED     ${where}\n` +
              `              recorded ${finding.expected}\n              found    ${finding.found}`
          : `  ALTERED     ${where}\n` +
              `              recorded ${finding.expectedBytes} bytes\n` +
              `              found    ${finding.foundBytes} bytes`;
    }
  });

  // Every fault below has the same first question — what wrote to the bucket —
  // except that a volume which is not there at all looks exactly like every
  // file being gone, and that is the cheaper thing to rule out first.
  const allMissing = findings.length === checked && findings.every((f) => f.fault === "missing");
  return [
    `Checked ${checked} file(s). ${findings.length} did not match what was recorded:`,
    ...lines,
    "",
    ...(allMissing
      ? [
          "Every file is gone, which is what a bucket this deployment is not",
          "actually pointed at also looks like. Check the STORAGE_* settings",
          "before concluding anything.",
        ]
      : [
          "A file that does not match what was recorded has changed since it was stored.",
          "Check first that it is still recorded: the rows were read before the bucket was,",
          "so evidence discarded and reclaimed during this run reads the same way here.",
          "If the file is still there, nothing in this product changed those bytes.",
        ]),
  ].join("\n");
}
