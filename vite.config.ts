// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

// Vite+ is the toolchain entry point: dev server, build, tests, lint, format.
// Per-app and per-package configuration arrives with the application scaffold.
export default defineConfig({
  // `bun run check` is the documented gate, so it has to type-check too;
  // without this it only formats and lints.
  lint: { options: { typeAware: true, typeCheck: true } },
  // Drizzle owns its migration metadata and rewrites it on every generate;
  // formatting it would diff against the tool on the next schema change.
  fmt: { ignorePatterns: ["**/migrations/meta/**"] },
});
