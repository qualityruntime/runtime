// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole database schema, as one object.
 *
 * `createDatabase` hands this to Drizzle, and Better Auth's adapter looks
 * tables up by the key they are exported under, so every table belongs here.
 */

export * from "./audit.ts";
export * from "./auth.ts";
export * from "./control.ts";
export * from "./evidence.ts";
export * from "./file.ts";
export * from "./file-upload.ts";
export * from "./control-requirement.ts";
export * from "./standard.ts";
