// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Auth } from "./auth.ts";

/**
 * The HTTP surface.
 *
 * Better Auth owns every route under `/api/auth` and validates methods itself,
 * so every method is forwarded. Domain routes mount alongside it as they
 * arrive; `/api/auth` is Better Auth's own API, not this product's public one.
 */
export function createApp(auth: Auth) {
  return new Hono().all("/api/auth/*", (c) => auth.handler(c.req.raw));
}

export type App = ReturnType<typeof createApp>;
