// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Applies the checked-in migrations and exercises the constraints they create.
 * PGlite is PostgreSQL compiled to WebAssembly, so this runs in `vp test` with
 * no database to start. It has a single connection, so nothing concurrent is
 * decided here: `apps/server/concurrency.test.ts` does that against a server.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableColumns, getTableName, inArray, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createId } from "../id.ts";
import * as schema from "./index.ts";
import * as auth from "./auth.ts";
import { account, member, organization, session, user } from "./auth.ts";
import { control } from "./control.ts";
import { requirement, standard } from "./standard.ts";

/** The same folder `drizzle-kit migrate` applies, resolved from this module. */
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  db = drizzle(new PGlite());
  await migrate(db, { migrationsFolder });
}, 60_000);

afterAll(() => db.$client.close());

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

  it("protect every domain table with forced row-level security", async () => {
    // Derived, so the next domain table cannot arrive without a policy — nor
    // without the column one would read: every table that is not Better
    // Auth's must belong to an organization. Better Auth's own tables are
    // excluded: it reads `member` and `invitation` to work out which
    // organizations a user belongs to, which happens before any organization
    // is known and so outside every tenant context.
    const authTables = new Set(
      Object.values(auth)
        .filter((value) => is(value, Table))
        .map((table) => getTableName(table as Table)),
    );
    const domain = Object.values(schema)
      .filter((value) => is(value, Table))
      .map((table) => table as Table)
      .filter((table) => !authTables.has(getTableName(table)));
    expect(
      domain.filter((table) => !("organizationId" in getTableColumns(table))).map(getTableName),
    ).toEqual([]);
    const tenantOwned = domain.map(getTableName).sort();
    // Guards the derivation itself: an empty list would make this test vacuous.
    expect(tenantOwned).toEqual([
      "audit_event",
      "control",
      "control_requirement",
      "evidence",
      "file",
      "requirement",
      "standard",
    ]);

    const { rows } = await db.$client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1)`,
      [tenantOwned],
    );

    // FORCE matters as much as ENABLE: without it PostgreSQL exempts the table
    // owner, and the guarantee would rest on the server never being one. How many
    // policies a table needs is its own business — `audit_event` names SELECT
    // and INSERT separately to be append-only — but having none would leave it
    // unreadable rather than protected.
    expect(rows.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual(
      tenantOwned.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: expect.any(Number) as number,
      })),
    );
    expect(rows.every((row) => row.policies > 0)).toBe(true);
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

describe("standards and requirements", () => {
  const newStandard = async (organizationId: string, edition = "2015") => {
    const [row] = await db
      .insert(standard)
      .values({ organizationId, name: "ISO 9001", edition })
      .returning();
    return row!;
  };

  const newRequirement = (parent: { id: string; organizationId: string }, reference = "7.5.3") => ({
    organizationId: parent.organizationId,
    standardId: parent.id,
    reference,
    title: "Control of documented information",
    position: 1,
  });

  it("holds one row per issue of a standard", async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    await newStandard(org!.id);

    // A second edition is a different standard; a second copy of one is not.
    await newStandard(org!.id, "2026");
    const duplicate = db
      .insert(standard)
      .values({ organizationId: org!.id, name: "ISO 9001", edition: "2015" });

    expect(await rejectedBy(duplicate)).toBe("standard_organization_id_name_edition_uidx");
  });

  it("lets two organizations each hold the same standard", async () => {
    const [a] = await db.insert(organization).values(newOrganization()).returning();
    const [b] = await db.insert(organization).values(newOrganization()).returning();

    await newStandard(a!.id);
    const theirs = await newStandard(b!.id);

    expect(theirs.id).toMatch(/^std_[0-9a-z]{16}$/);
  });

  it("refuses a requirement filed under another organization's standard", async () => {
    // The whole reason the foreign key is composite: this is the shape a
    // cross-tenant reference would take, and it has to be impossible rather
    // than merely wrong (TENANT-01).
    const [a] = await db.insert(organization).values(newOrganization()).returning();
    const [b] = await db.insert(organization).values(newOrganization()).returning();
    const theirs = await newStandard(a!.id);

    const smuggled = db
      .insert(requirement)
      .values({ ...newRequirement(theirs), organizationId: b!.id });

    expect(await rejectedBy(smuggled)).toBe("requirement_standard_fk");
  });

  it("refuses the same clause twice in one standard", async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const parent = await newStandard(org!.id);
    await db.insert(requirement).values(newRequirement(parent));

    const duplicate = db.insert(requirement).values({ ...newRequirement(parent), position: 2 });

    expect(await rejectedBy(duplicate)).toBe("requirement_standard_id_reference_uidx");
  });

  it("allows the same clause reference under a different standard", async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const first = await newStandard(org!.id);
    const second = await newStandard(org!.id, "2026");

    await db.insert(requirement).values(newRequirement(first));
    await db.insert(requirement).values(newRequirement(second));

    // Scoped to these two: other cases in this file have written 7.5.3 too.
    const rows = await db
      .select()
      .from(requirement)
      .where(inArray(requirement.standardId, [first.id, second.id]));
    expect(rows.map((row) => row.reference)).toEqual(["7.5.3", "7.5.3"]);
  });

  it.each([
    ["a standard with no name", () => ({ name: "  ", edition: "2015" }), "standard_name_present"],
    [
      "a standard with no edition",
      () => ({ name: "ISO 9001", edition: "" }),
      "standard_edition_present",
    ],
  ])("refuses %s", async (_case, values, constraint) => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();

    const rejected = db.insert(standard).values({ organizationId: org!.id, ...values() });

    expect(await rejectedBy(rejected)).toBe(constraint);
  });

  it("allows two requirements to share a position", async () => {
    // Ties let a clause use an occupied position without renumbering later
    // clauses. The cost is that `position` alone is not an order, which is why
    // the index carries the id.
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const parent = await newStandard(org!.id);

    await db.insert(requirement).values(newRequirement(parent, "7.5.3"));
    await db.insert(requirement).values(newRequirement(parent, "7.5.4"));

    const rows = await db
      .select()
      .from(requirement)
      .where(eq(requirement.standardId, parent.id))
      .orderBy(requirement.position, requirement.id);
    expect(rows.map((row) => row.position)).toEqual([1, 1]);
  });

  it("deletes a standard's requirements with the standard", async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const parent = await newStandard(org!.id);
    await db.insert(requirement).values(newRequirement(parent));

    await db.delete(standard).where(eq(standard.id, parent.id));

    const rows = await db.select().from(requirement).where(eq(requirement.standardId, parent.id));
    expect(rows).toEqual([]);
  });

  it("deletes both with the organization", async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    const parent = await newStandard(org!.id);
    await db.insert(requirement).values(newRequirement(parent));

    await db.delete(organization).where(eq(organization.id, org!.id));

    expect(await db.select().from(standard).where(eq(standard.organizationId, org!.id))).toEqual(
      [],
    );
    expect(
      await db.select().from(requirement).where(eq(requirement.organizationId, org!.id)),
    ).toEqual([]);
  });
});

describe("control", () => {
  /** A control needs a tenant, so every case here starts from a fresh one. */
  const inNewOrganization = async () => {
    const [org] = await db.insert(organization).values(newOrganization()).returning();
    return org!.id;
  };

  it("starts life as a draft", async () => {
    const organizationId = await inNewOrganization();

    const [row] = await db
      .insert(control)
      .values({ organizationId, name: "Access review" })
      .returning();

    expect(row?.id).toMatch(/^ctl_[0-9a-z]{16}$/);
    expect(row?.status).toBe("draft");
    expect(row?.description).toBeNull();
  });

  it("rejects a status outside the lifecycle", async () => {
    const organizationId = await inNewOrganization();
    // Cast past the union the column declares: the point is what reaches the
    // database when something upstream does not type-check.
    const values = { organizationId, name: "Access review", status: "approved" as "active" };

    expect(await rejectedBy(db.insert(control).values(values))).toBe("control_status_valid");
  });

  it("rejects a name that is only whitespace", async () => {
    const organizationId = await inNewOrganization();

    // Tabs and newlines included: `btrim` alone would let those through.
    for (const name of ["", "   ", "\t", "\n", " \t\n "]) {
      expect(await rejectedBy(db.insert(control).values({ organizationId, name }))).toBe(
        "control_name_present",
      );
    }
  });

  it("rejects a control belonging to no existing tenant", async () => {
    const values = { organizationId: createId("organization"), name: "Access review" };

    expect(await rejectedBy(db.insert(control).values(values))).toBe(
      "control_organization_id_organization_id_fk",
    );
  });

  it("deletes a tenant's controls with the tenant", async () => {
    const organizationId = await inNewOrganization();
    await db.insert(control).values({ organizationId, name: "Access review" });

    await db.delete(organization).where(eq(organization.id, organizationId));

    const rows = await db.select().from(control).where(eq(control.organizationId, organizationId));
    expect(rows).toEqual([]);
  });
});
