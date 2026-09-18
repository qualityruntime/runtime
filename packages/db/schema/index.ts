// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole database schema, as one object.
 *
 * `createDatabase` hands this to Drizzle, and Better Auth's adapter looks
 * tables up by the key they are exported under, so every table belongs here.
 */

export * from "./auth.ts";
