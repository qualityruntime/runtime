// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks this configuration against the schema in `packages/db`.
 *
 * Structurally: every model `authOptions` causes Better Auth to write must be
 * exported under the name its adapter looks up, with a column for every field.
 * Behaviourally: representative flows — credential sign-up and creating an
 * organization — run against migrated PostgreSQL, so Better Auth's own writes
 * are shown to satisfy the identifier CHECK constraints. Verification,
 * invitation, and two-factor writes are not exercised here.
 *
 * Both of those derive from `authOptions`, so a plugin change moves the
 * expectation with it rather than leaving a second list to update.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema } from "@qualityruntime/db";
import { getAuthTables } from "better-auth/db";
import { eq, getTableColumns, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { type Auth, authOptions, createAuth } from "./auth.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

let db: ReturnType<typeof drizzle>;
let auth: Auth;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder });
  auth = createAuth(db, {
    baseURL: "http://localhost",
    secret: "test-secret-of-at-least-32-characters",
  });
  app = createApp(auth);
}, 60_000);

/** Drops the response attributes so the value is a valid `Cookie` request header. */
const toCookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");

const signUp = (email: string) =>
  app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email, password: "correct horse battery" }),
  });

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe.each(Object.entries(getAuthTables(authOptions)))("%s", (key, table) => {
  const name = table.modelName || key;
  // Better Auth's Drizzle adapter finds a table by the key it is exported
  // under, not by its physical name.
  const exported = (schema as Record<string, unknown>)[name];

  it("is exported under the name the adapter looks up", () => {
    expect(is(exported, Table)).toBe(true);
  });

  it("has a column for every field Better Auth writes", () => {
    const columns = Object.keys(getTableColumns(exported as Table));
    const written = Object.entries(table.fields).map(
      ([field, attribute]) => attribute.fieldName || field,
    );
    expect(columns).toEqual(expect.arrayContaining(written));
  });

  it("does not require a column Better Auth never writes", () => {
    const columns = getTableColumns(exported as Table);
    const written = new Set([
      "id",
      ...Object.entries(table.fields).map(([field, attribute]) => attribute.fieldName || field),
    ]);
    const unsatisfiable = Object.entries(columns)
      .filter(([column]) => !written.has(column))
      .filter(([, column]) => column.notNull && !column.hasDefault)
      .map(([column]) => column);
    expect(unsatisfiable).toEqual([]);
  });
});

describe("configuration", () => {
  it("refuses a secret shorter than Better Auth's documented minimum", () => {
    // Better Auth only warns, so this guard is the thing that stops a short
    // secret reaching production.
    expect(() => createAuth(db, { baseURL: "http://localhost", secret: "too-short" })).toThrow(
      /at least 32 characters/,
    );
  });
});

describe("Better Auth writes against the migrated schema", () => {
  it("creates a user, its credential account, and a session", async () => {
    const response = await signUp("ada@example.test");
    expect(response.status).toBe(200);
    const { user } = await json<{ user: { id: string } }>(response);

    expect(user.id).toMatch(/^usr_[0-9a-z]{16}$/);
    const [account] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, user.id));
    expect(account?.id).toMatch(/^acc_[0-9a-z]{16}$/);
    expect(account?.providerId).toBe("credential");

    const [session] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, user.id));
    expect(session?.id).toMatch(/^ses_[0-9a-z]{16}$/);
  });

  it("creates an organization with its owner membership", async () => {
    const signedUp = await signUp("owner@example.test");
    expect(signedUp.status).toBe(200);
    const userId = (await json<{ user: { id: string } }>(signedUp)).user.id;

    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: toCookieHeader(signedUp) },
      body: JSON.stringify({ name: "Acme", slug: "acme" }),
    });
    expect(created.status).toBe(200);
    const organization = await json<{ id: string }>(created);

    expect(organization.id).toMatch(/^org_[0-9a-z]{16}$/);
    const [member] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, organization.id));
    expect(member?.id).toMatch(/^mem_[0-9a-z]{16}$/);
    expect(member?.userId).toBe(userId);
    expect(member?.role).toBe("owner");
  });
});
