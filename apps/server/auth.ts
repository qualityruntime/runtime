// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { generateId, schema } from "@qualityruntime/db";
// `minimal` leaves out the bundled Kysely path, which the Drizzle adapter
// replaces; it keeps the Workers bundle smaller.
import { getCookies } from "better-auth/cookies";
import { betterAuth } from "better-auth/minimal";
import type { BetterAuthOptions } from "better-auth/types";
import { admin, organization, twoFactor } from "better-auth/plugins";

/** Whatever the Drizzle adapter accepts: any Drizzle PostgreSQL driver, so
 * broader than the node-postgres `Database` query code uses. */
type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

/**
 * The only path a browser sends the session cookie to.
 *
 * Exported because it is a security boundary rather than a route detail: the
 * object store is refused the moment it answers inside this path
 * (`assertStorageOutsideCookiePath`), and that check must be judging the same
 * string this sets.
 */
export const sessionCookiePath = "/api";

/**
 * The static Better Auth configuration, shared by the runtime and the
 * compatibility test.
 *
 * Some of it decides which tables and columns exist — the plugin list above
 * all — so `auth.test.ts` derives Better Auth's expected schema from this same
 * object rather than a second copy. Teams and dynamic access control stay off;
 * both add tables (ADR 0001).
 */
export const authOptions = {
  // Authenticator apps show this as the TOTP issuer.
  appName: "Quality Runtime",
  emailAndPassword: { enabled: true },
  plugins: [
    // Deleting an organization cascades through every tenant-owned table,
    // and a foreign key's cascade answers to neither row-level security nor
    // table privileges — it would take the audit log and every attestation
    // with it. Removing a tenant is an operator's job, not a self-serve
    // route an owner can reach (ADR 0005, ADR 0012, ADR 0014).
    organization({ disableOrganizationDeletion: true }),
    admin(),
    twoFactor(),
  ],
  advanced: {
    // Identifiers are prefixed and CHECK-enforced, so Better Auth must
    // generate them through `@qualityruntime/db` or every insert is rejected
    // (ADR 0002).
    database: { generateId },
    // Both attributes keep this cookie off the object store a download
    // redirects to: the path is every route here, and no `domain` leaves the
    // cookie host-only. Depth rather than a boundary (ADR 0021).
    defaultCookieAttributes: { path: sessionCookiePath },
  },
} satisfies BetterAuthOptions;

export interface AuthEnvironment {
  /** Public origin the instance is reached at, used for callbacks and cookies. */
  baseURL: string;
  /** At least 32 high-entropy characters; used for encryption, signing, and hashing. */
  secret: string;
}

/**
 * Builds the Better Auth instance for a database handle.
 *
 * Takes the handle rather than opening one so a test can bind it to a
 * throwaway database, matching `createDatabase` (ARCH-01).
 */
export function createAuth(db: AuthDatabase, { baseURL, secret }: AuthEnvironment) {
  // Better Auth logs a warning below this length and carries on; a short secret
  // should not be able to reach production quietly.
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");
  }

  return betterAuth({
    ...authOptions,
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema }),
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The cookie Better Auth authenticates a session with, for this instance.
 *
 * Asked of Better Auth rather than written down: it prefixes the name with
 * `__Secure-` when the base URL is HTTPS, so a fixed string would be right in
 * development and wrong in every deployment. `openapi.ts` publishes it.
 */
export const sessionCookieName = (auth: Auth): string => getCookies(auth.options).sessionToken.name;
