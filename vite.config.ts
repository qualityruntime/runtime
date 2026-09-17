// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

// Vite+ is the toolchain entry point: dev server, build, tests, lint, format.
// Per-app and per-package configuration arrives with the application scaffold.
export default defineConfig({
  fmt: { ignorePatterns: [] },
});
