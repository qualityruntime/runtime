// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding bytes in the bucket that no row claims, and removing them when asked.
 *
 * `integrity.ts` asks whether every row still has its bytes; this asks the
 * other direction (ADR 0016, ADR 0021). Two things leave bytes behind: uploads
 * prepared and abandoned, and files whose rows went with a cascade, because
 * discarding evidence takes its `file` rows and a foreign key cannot reach a
 * bucket.
 *
 * The only thing here that deletes evidence bytes, so it is built to be wrong
 * safely rather than to be thorough:
 *
 * - it reports by default and removes only when told to;
 * - it leaves alone anything written recently, so an object promoted while a
 *   completion is still committing is never mistaken for an orphan;
 * - it touches only keys shaped like ones this product issued, so other
 *   content in the same bucket is left alone;
 * - and it refuses outright when the database holds no files at all, which is
 *   what an empty or unrestored database looks like from here.
 *
 * None of that establishes that this database is the authority for this
 * bucket. Ownership is inferred negatively, so a database that is not this
 * deployment's — or a bucket a second deployment also writes to — makes live
 * objects look unclaimed, and the key-shape test cannot help because those
 * keys really are this product's. The empty-database refusal catches one shape
 * of that and no other, so `--remove` requires the deployment's own database
 * and an unshared prefix as a documented precondition the operator meets
 * (`docs/deployment.md`).
 *
 * Not a route, for the reason `integrity.ts` is not one.
 */

import { type Database, idPattern, schema, withOrganization } from "@qualityruntime/db";
import { and, asc, gt, isNull, lt, sql } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ObjectStore, StoredPrefix } from "./objects.ts";

/**
 * How long an object must have existed before this considers it, and how long
 * an expired upload's row outlives its window.
 *
 * Promotion and the commit of the row naming it are two operations with no
 * transaction between them. A day is far longer than that window, and short
 * enough that abandoned uploads do not pile up for a week.
 */
export const gracePeriod = 24 * 60 * 60 * 1000;

/** Bytes nothing claims. */
export type Orphan = {
  key: string;
  bytes: number;
  writtenAt: Date;
  /** `upload`: prepared and never completed. `file`: its row is gone. */
  kind: "upload" | "file";
};

export type Reclamation = {
  orphans: Orphan[];
  /** How many objects were actually removed. Zero unless asked. */
  removed: number;
  /**
   * How much the keys that were actually removed held — not the size of
   * everything found, which would report space nobody got back.
   *
   * Removed, not reclaimed: on a versioned bucket a `DELETE` writes a delete
   * marker, so the key stops resolving and the bill does not move until a
   * noncurrent-version expiry rule runs (`docs/deployment.md`).
   */
  removedBytes: number;
  /** Objects the store would not let go of, and why. */
  failed: { key: string; detail: string }[];
  /** Expired upload intents whose rows were removed with them. */
  intents: number;
  /** Objects left alone for being younger than the grace period. */
  recent: number;
  /** Keys shaped unlike anything this product issues, left alone. */
  foreign: number;
  /** Why nothing was removed, when something could have been. */
  refused?: string;
};

/** A handle that is not already a transaction, which is what this starts from. */
type Handle<Q extends PgQueryResultHKT> = Database<Q> & { rollback?: never };

const isFileId = new RegExp(idPattern("file"));
const isUploadId = new RegExp(idPattern("fileUpload"));

/** The identifier a key names, without the prefix that says what kind it is. */
const idOf = (key: string) => key.slice(key.indexOf("/") + 1);

/**
 * Every identifier a row still claims, read inside each tenant's own context.
 *
 * Read before the bucket is listed rather than after; the grace period
 * already does that work, since an object promoted after this read is younger
 * than a day and skipped for that reason.
 *
 * An upload claims its bytes only while it could still be completed. One that
 * expired cannot be, and one that produced a file has had its temporary object
 * removed, so what is left under `uploads/` in either case is garbage.
 */
async function claimed<Q extends PgQueryResultHKT>(db: Handle<Q>) {
  const organizations = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .orderBy(asc(schema.organization.id));

  const files = new Set<string>();
  const uploads = new Set<string>();
  for (const { id } of organizations) {
    await withOrganization(db, id, async (tx) => {
      for (const row of await tx.select({ id: schema.file.id }).from(schema.file)) {
        files.add(row.id);
      }
      // On the database's clock, because the completion policy decides on that
      // one. A sweeper reading its own could stop treating bytes as claimed
      // while PostgreSQL would still accept the upload.
      const open = await tx
        .select({ id: schema.fileUpload.id })
        .from(schema.fileUpload)
        .where(
          and(
            isNull(schema.fileUpload.fileId),
            gt(schema.fileUpload.expiresAt, sql`clock_timestamp()`),
          ),
        );
      for (const row of open) uploads.add(row.id);
    });
  }
  return { organizations: organizations.map(({ id }) => id), files, uploads };
}

/**
 * Removes the rows of uploads that expired without being completed.
 *
 * `file_upload_tenant_reclaim` admits exactly these — never one that produced
 * a file, which is the receipt a retry reads — so the predicate here is a
 * courtesy and the database refuses the rest.
 *
 * The grace period is stricter than the policy on purpose. A completion whose
 * window closed mid-flight is refused either way; keeping the row as long as
 * its bytes buys it "the window closed" instead of "no such upload".
 */
async function forgetExpired<Q extends PgQueryResultHKT>(
  db: Handle<Q>,
  organizations: string[],
  cutoff: Date,
): Promise<number> {
  let removed = 0;
  for (const id of organizations) {
    const gone = await withOrganization(db, id, (tx) =>
      tx
        .delete(schema.fileUpload)
        .where(and(isNull(schema.fileUpload.fileId), lt(schema.fileUpload.expiresAt, cutoff)))
        .returning({ id: schema.fileUpload.id }),
    );
    removed += gone.length;
  }
  return removed;
}

/**
 * Finds what no row claims, and removes it when `remove` is set.
 *
 * `now` is a parameter so that a test can age an object rather than wait a day.
 */
export async function reclaimStorage<Q extends PgQueryResultHKT>(
  db: Handle<Q>,
  store: ObjectStore,
  { remove = false, now = new Date() }: { remove?: boolean; now?: Date } = {},
): Promise<Reclamation> {
  const live = await claimed(db);
  const cutoff = new Date(now.getTime() - gracePeriod);

  const orphans: Orphan[] = [];
  let recent = 0;
  let foreign = 0;

  const sweep = async (
    kind: Orphan["kind"],
    prefix: StoredPrefix,
    keeps: (id: string) => boolean,
  ) => {
    for await (const object of store.list(prefix)) {
      const id = idOf(object.key);
      // A bucket may be shared, and nothing in it that this product did not
      // name is this product's to remove.
      if (object.key !== prefix + id || !(kind === "file" ? isFileId : isUploadId).test(id)) {
        foreign += 1;
        continue;
      }
      if (keeps(id)) continue;
      if (object.writtenAt > cutoff) {
        recent += 1;
        continue;
      }
      orphans.push({ ...object, kind });
    }
  };

  await sweep("file", "files/", (id) => live.files.has(id));
  await sweep("upload", "uploads/", (id) => live.uploads.has(id));

  const found: Reclamation = {
    orphans,
    removed: 0,
    removedBytes: 0,
    failed: [],
    intents: 0,
    recent,
    foreign,
  };

  // A replica that never caught up, a restore that never loaded, a fresh
  // database: every permanent object looks unclaimed, and that is
  // indistinguishable from a deployment whose records were all removed on
  // purpose. Only one of the two is recoverable, so this refuses.
  if (live.files.size === 0 && orphans.some((orphan) => orphan.kind === "file")) {
    return {
      ...found,
      refused:
        "No files are recorded at all, which is one of the things a database that is not " +
        "this deployment's looks like from here. Check that DATABASE_URL names it.",
    };
  }

  if (!remove) return found;

  for (const orphan of orphans) {
    // A store that refuses one object must not stop the rest being tried, nor
    // lose the record of what already went: a run that gives up at the first
    // fault hides what it had found. `integrity.ts` follows the same rule.
    try {
      await store.discard(orphan.key);
      found.removed += 1;
      found.removedBytes += orphan.bytes;
    } catch (error) {
      found.failed.push({ key: orphan.key, detail: String(error) });
    }
  }
  // After the bytes. Either order is recoverable, since the next run finds
  // whichever half was left.
  found.intents = await forgetExpired(db, live.organizations, cutoff);
  return found;
}

/** What a person running this needs to read, in the order they need it. */
export function describeReclamation(reclamation: Reclamation): string {
  const { orphans, removed, removedBytes, failed, intents, recent, foreign, refused } = reclamation;
  const alsoIntents = intents > 0 ? [`Also removed ${intents} expired upload record(s).`] : [];
  const skipped = [
    recent > 0 && `${recent} written too recently to judge`,
    foreign > 0 && `${foreign} under keys this product did not issue`,
  ].filter(Boolean) as string[];
  const aside =
    (skipped.length > 0 ? `\nLeft alone: ${skipped.join(", ")}.` : "") +
    (failed.length > 0
      ? `\n${failed.length} could not be removed:\n` +
        failed.map(({ key, detail }) => `  ${key}\n    ${detail}`).join("\n")
      : "");

  if (refused) {
    return [
      `Found ${orphans.length} object(s) that no row claims, and removed none of them.`,
      "",
      refused,
    ].join("\n");
  }

  if (orphans.length === 0) {
    // The rows are the other half of a run, and a report that mentions only
    // the bucket reads as "nothing happened" on a run that changed PostgreSQL.
    return [`Nothing in the bucket is unclaimed.`, ...alsoIntents].join("\n") + aside;
  }

  const bytes = orphans.reduce((total, orphan) => total + orphan.bytes, 0);
  // A neglected bucket can hold thousands, and a report nobody can scroll
  // through is one nobody reads. The count above is the number that matters.
  const shown = orphans.slice(0, 50);
  const lines = [
    ...shown.map(
      (orphan) =>
        `  ${orphan.kind === "file" ? "FILE  " : "UPLOAD"}  ${orphan.key}  ` +
        `${orphan.bytes} bytes  ${orphan.writtenAt.toISOString()}`,
    ),
    ...(orphans.length > shown.length ? [`  … and ${orphans.length - shown.length} more`] : []),
  ];

  if (removed === 0) {
    return (
      [
        `Found ${orphans.length} object(s) that no row claims, ${bytes} bytes in all:`,
        ...lines,
        "",
        // Telling an operator whose every removal was refused to run it again
        // with the flag they just used is how a report loses their attention.
        failed.length > 0
          ? "Nothing could be removed. The store refused every one; see below."
          : "Nothing was removed. Run again with --remove to remove them.",
      ].join("\n") + aside
    );
  }

  // What was found and what was let go of are two numbers whenever the store
  // refused one. "Removed" rather than "reclaimed" for the other reason: on a
  // versioned bucket the key stops resolving and the bytes stay until a
  // noncurrent-version expiry rule takes them.
  return (
    [
      `Found ${orphans.length} object(s) that no row claims, ${bytes} bytes in all:`,
      ...lines,
      "",
      `Removed ${removed} of them, ${removedBytes} bytes.`,
      ...alsoIntents,
    ].join("\n") + aside
  );
}
