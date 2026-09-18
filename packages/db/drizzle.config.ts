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
// the root and from this package. The file is optional when DATABASE_URL
// is supplied by the environment.
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
    // Only read by commands that connect, so `generate` works without it.
    get url() {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set; it is required to reach the database.");
      return url;
    },
  },
});
