// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports bytes in the bucket that no row claims, and removes them when asked.
 *
 * Reports by default. `--remove` is what deletes anything, and it is a separate
 * word on purpose: this is the only thing here that can destroy evidence bytes,
 * and a flag typed on purpose is the difference between an operator who meant
 * it and a scheduled job nobody reread.
 *
 * Deployment-specific, like `bun.ts`: it reads the environment and owns its own
 * connection. The work itself is in `reclaim.ts` and knows nothing of either.
 */

import { assertTenantIsolation, createDatabase } from "@qualityruntime/db";
import { Pool } from "pg";
import { requireEnv, storageConfiguration } from "./environment.ts";
import { assertBucket, objectStoreInS3 } from "./objects-in-s3.ts";
import { describeReclamation, reclaimStorage } from "./reclaim.ts";

const remove = process.argv.includes("--remove");

const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
try {
  const db = createDatabase(pool);

  // A role that bypasses row-level security would read every organization's
  // rows inside each organization's context. Harmless for a report; for a run
  // that deletes, reading the wrong set of rows is the whole danger
  // (ADR 0003, ADR 0021).
  await assertTenantIsolation(db);

  // A bucket that does not answer lists nothing, and a sweep that listed
  // nothing would report a clean bucket rather than a misconfigured one.
  const storage = storageConfiguration();
  await assertBucket(storage);

  const reclamation = await reclaimStorage(db, objectStoreInS3(storage), { remove });

  console.log(describeReclamation(reclamation));
  // Non-zero when there is something for a person to do — a refusal, bytes
  // found and left, or bytes the store would not let go of — so a scheduled
  // report is noticed without its output being read.
  if (reclamation.refused || reclamation.failed.length > 0) process.exitCode = 1;
  else if (reclamation.orphans.length > 0 && reclamation.removed === 0) process.exitCode = 1;
} finally {
  await pool.end();
}
