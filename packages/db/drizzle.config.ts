// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// drizzle-kit resolves `schema` and `out` against the working directory and
// rejects absolute paths, so they are re-based onto this file's own location.
// `|| "."` covers running from this directory, where the relative path is "".
const packageDir = relative(process.cwd(), fileURLToPath(new URL(".", import.meta.url))) || ".";

// The repository keeps one `.env` at its root; drizzle-kit only reads the
// working directory's. Loading it here makes the commands behave the same from
// the root and from this package. The file is optional when
// MIGRATION_DATABASE_URL is supplied by the environment.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// Migrations are checked in and forward-only (MIGRATION-01): `drizzle-kit
// generate --name=<change>` writes a new one, and an existing file is never
// edited.
export default defineConfig({
  dialect: "postgresql",
  schema: `${packageDir}/schema/index.ts`,
  out: `${packageDir}/migrations`,
  // Columns carry explicit names, which win; this only decides how a column
  // added without one is spelled. Must match `createDatabase`.
  casing: "snake_case",
  dbCredentials: {
    /**
     * Only read by commands that connect, so `generate` works without it.
     *
     * The migrator's, and never the server's `DATABASE_URL` as a fallback:
     * migrations are applied by the role that owns the schema and runs with
     * `row_security = off`, so a data migration that forgot its tenant fails
     * rather than quietly matching nothing (ADR 0014). Keep this credential
     * separate from the runtime role's.
     */
    get url() {
      const url = process.env.MIGRATION_DATABASE_URL;
      if (!url) {
        throw new Error("MIGRATION_DATABASE_URL is not set; migrations connect as the migrator.");
      }
      return url;
    },
  },
});
