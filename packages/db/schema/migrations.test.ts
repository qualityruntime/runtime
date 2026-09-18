// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Applies the checked-in migrations to a real PostgreSQL engine and exercises
 * the constraints they create. PGlite is PostgreSQL compiled to WebAssembly, so
 * this runs in `vp test` with no database to start and nothing to clean up.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createId } from "../id.ts";
import * as schema from "./index.ts";
import { account, member, organization, session, user } from "./auth.ts";

/** The same folder `drizzle-kit migrate` applies, resolved from this module. */
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(new PGlite());
  await migrate(db, { migrationsFolder });
}, 60_000);

/** The constraint PostgreSQL rejected the statement with. */
async function rejectedBy(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    return (error as { cause?: { constraint?: string } }).cause?.constraint;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

const newUser = () => ({ name: "Ada", email: `${createId("user")}@example.test` });

const newOrganization = () => ({ name: "Acme", slug: createId("organization") });

describe("migrations", () => {
  it("create exactly the tables the schema declares", async () => {
    // Derived, so adding a table without a migration fails here, and so does a
    // migration that leaves a table behind.
    const declared = Object.values(schema)
      .filter((value) => is(value, Table))
      .map((table) => getTableName(table as Table))
      .sort();
    const { rows } = await db.$client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name <> '__drizzle_migrations'`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual(declared);
  });

  it("give every timestamp a time zone", async () => {
    const { rows } = await db.$client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type = 'timestamp without time zone'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("identifier CHECK constraints", () => {
  it("accept an identifier this package generated", async () => {
    const [row] = await db.insert(user).values(newUser()).returning();
    expect(row?.id).toMatch(/^usr_[0-9a-z]{16}$/);
  });

  it("reject an identifier carrying another table's prefix", async () => {
    const values = { id: createId("organization"), ...newUser() };
    expect(await rejectedBy(db.insert(user).values(values))).toBe("user_id_format");
  });

  it("reject the unprefixed identifier Better Auth's own generator produces", async () => {
    const values = { id: "sdf4artyuiop1qwe", ...newUser() };
    expect(await rejectedBy(db.insert(user).values(values))).toBe("user_id_format");
  });

  it("reject an otherwise valid identifier carrying uppercase", async () => {
    // The alphabet is lowercase, so case can never be significant downstream.
    const values = { id: "usr_V1StGXR8Z5jdHi6B", ...newUser() };
    expect(await rejectedBy(db.insert(user).values(values))).toBe("user_id_format");
  });
});

describe("account identity", () => {
  it("allows one account per provider and external id", async () => {
    const [userRow] = await db.insert(user).values(newUser()).returning();
    const identity = {
      userId: userRow!.id,
      providerId: "github",
      accountId: "external-12345",
    };

    await db.insert(account).values(identity);

    // Better Auth throws when this pair matches more than one row, so a
    // duplicate would break sign-in rather than degrade it.
    expect(await rejectedBy(db.insert(account).values(identity))).toBe(
      "account_provider_id_account_id_uidx",
    );
  });

  it("allows the same external id under a different provider", async () => {
    const [userRow] = await db.insert(user).values(newUser()).returning();
    const shared = { userId: userRow!.id, accountId: "external-12345" };

    await db.insert(account).values({ ...shared, providerId: "gitlab" });
    await db.insert(account).values({ ...shared, providerId: "google" });

    const rows = await db.select().from(account).where(eq(account.userId, userRow!.id));
    expect(rows).toHaveLength(2);
  });
});

describe("tenant integrity", () => {
  it("allows a user one membership per organization", async () => {
    const [userRow] = await db.insert(user).values(newUser()).returning();
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const membership = { organizationId: org!.id, userId: userRow!.id };

    await db.insert(member).values(membership);

    expect(await rejectedBy(db.insert(member).values(membership))).toBe(
      "member_organization_id_user_id_uidx",
    );
  });

  it("clears a session's active organization when that tenant is deleted", async () => {
    const [userRow] = await db.insert(user).values(newUser()).returning();
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const [row] = await db
      .insert(session)
      .values({
        userId: userRow!.id,
        activeOrganizationId: org!.id,
        // A session id and a session token are different things; do not blur them.
        token: "test-session-token",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();

    await db.delete(organization).where(eq(organization.id, org!.id));

    const [after] = await db.select().from(session).where(eq(session.id, row!.id));
    expect(after?.activeOrganizationId).toBeNull();
  });
});
