// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole database schema, as one object.
 *
 * Drizzle's relational queries and Better Auth's Drizzle adapter both address
 * tables by the key they are exported under, so every table belongs here.
 */

export * from "./auth.ts";
