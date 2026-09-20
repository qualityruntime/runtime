// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks every stored file against the checksum recorded for it.
 *
 * A command rather than a route: it reads every byte the deployment holds, and
 * a deployment should run it on a schedule of its own choosing rather than have
 * a request wait for it. Exits non-zero when anything does not match, so `cron`
 * or a CI job notices without reading the output.
 *
 * Deployment-specific, like `bun.ts`: it reads the environment and owns its own
 * connection. The work itself is in `integrity.ts` and knows nothing of either.
 */

import { assertTenantIsolation, createDatabase } from "@qualityruntime/db";
import { Pool } from "pg";
import { requireEnv, storageConfiguration } from "./environment.ts";
import { describeVerification, verifyEverything } from "./integrity.ts";
import { assertBucket, objectStoreInS3 } from "./objects-in-s3.ts";

const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });
try {
  const db = createDatabase(pool);

  // This is invited to run against a replica or a backup host, which is a
  // different connection string chosen by someone thinking "it only reads".
  // A role that bypasses row-level security would read every organization's
  // rows inside each organization's context, counting and reporting every
  // file once per organization (ADR 0003, ADR 0016).
  await assertTenantIsolation(db);

  // Every file reading as missing is what a misconfigured bucket looks like,
  // and this command's report is what an operator acts on.
  const storage = storageConfiguration();
  await assertBucket(storage);

  const verification = await verifyEverything(db, objectStoreInS3(storage));

  console.log(describeVerification(verification));
  if (verification.findings.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
