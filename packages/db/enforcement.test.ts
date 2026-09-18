// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant isolation and database-enforced lifecycle rules.
 *
 * PGlite's default role is a superuser, which bypasses row-level security.
 * After migration and fixture setup, tests use a non-superuser role, except
 * where a case is about the superuser itself: a start-up refusal, or an
 * operator removing a tenant. That role owns `control` to exercise FORCE ROW
 * LEVEL SECURITY on an owner; deployment runtime roles should own nothing.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createId } from "./id.ts";
import * as schema from "./schema/index.ts";
import {
  auditEvent,
  control,
  controlRequirement,
  evidence,
  file,
  organization,
  requirement,
  standard,
} from "./schema/index.ts";
import { assertTenantIsolation, withOrganization } from "./tenant.ts";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/** Stands in for the role a deployment connects as: no superuser, no BYPASSRLS. */
const applicationRole = "qualityruntime_app";

/** Bound to the schema and casing `createDatabase` uses, so the handle matches
 * the one the server passes to `withOrganization`. */
let db: ReturnType<typeof createTestDatabase>;

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

/** Two tenants, each with one control, created before the role drops. */
let tenantA: string;
let tenantB: string;
let controlA: string;

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });

  // Seeded as the superuser, so the fixtures do not depend on what is being
  // tested. Both tenants get a control; neither should ever see the other's.
  const [a, b] = await db
    .insert(organization)
    .values([
      { name: "Acme", slug: createId("organization") },
      { name: "Globex", slug: createId("organization") },
    ])
    .returning();
  tenantA = a!.id;
  tenantB = b!.id;
  const [row] = await db
    .insert(control)
    .values([
      { organizationId: tenantA, name: "Access review" },
      { organizationId: tenantB, name: "Supplier audit" },
    ])
    .returning();
  controlA = row!.id;

  // The application role: not a superuser, and the owner of `control`, so
  // FORCE is what makes that table's policies apply to it.
  await client.exec(`
    create role ${applicationRole} nosuperuser nobypassrls;
    grant all on all tables in schema public to ${applicationRole};
    alter table "control" owner to ${applicationRole};
    set role ${applicationRole};
  `);
}, 60_000);

afterAll(() => db.$client.close());

/**
 * PostgreSQL raises `insufficient_privilege` when a write fails a policy's WITH
 * CHECK. Drizzle wraps the message, so the code on the cause is what identifies
 * it; matching the text would pass for any failed query.
 */
const insufficientPrivilege = "42501";

/** The PostgreSQL error code a statement was rejected with. */
async function rejectedWith(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    return (error as { cause?: { code?: string } }).cause?.code;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

/** PostgreSQL's code for a trigger or a restricting foreign key refusing a write. */
const restrictViolation = "23001";

/** PostgreSQL's code for a CHECK constraint refusing a row. */
const checkViolation = "23514";

/** Rows of `control` the current role can see, whatever tenant they belong to. */
const visibleControls = () => db.select().from(control);

describe("assertTenantIsolation", () => {
  it("accepts a role that policies apply to", async () => {
    await expect(assertTenantIsolation(db)).resolves.toBeUndefined();
  });

  it("rejects a role that bypasses row-level security", async () => {
    // The superuser PGlite connects as by default, and the one a container
    // image hands you: every policy in the database is inert for it.
    await db.$client.exec("reset role;");

    await expect(assertTenantIsolation(db)).rejects.toThrow(/bypasses row-level security/);

    await db.$client.exec(`set role ${applicationRole};`);
  });

  it("rejects a database whose table does not force row-level security", async () => {
    // The role owns `control`, so it can do this — and as the owner, it would
    // then be exempt from that table's policies.
    await db.$client.exec('alter table "control" no force row level security;');
    try {
      await expect(assertTenantIsolation(db)).rejects.toThrow(/not enabled and forced on control/);
    } finally {
      await db.$client.exec('alter table "control" force row level security;');
    }
  });

  it("rejects a connection with row_security off, the migrator's setting", async () => {
    await db.$client.exec("set row_security = off;");
    try {
      await expect(assertTenantIsolation(db)).rejects.toThrow(/row_security = off/);
    } finally {
      await db.$client.exec("reset row_security;");
    }
  });
});

describe("row-level security", () => {
  it("hides every tenant's rows when no organization is set", async () => {
    // The dangerous default is the opposite: a forgotten context showing
    // everything. NULL never equals an organization id, so the table is empty.
    expect(await visibleControls()).toEqual([]);
  });

  it("refuses a write outside a tenant context", async () => {
    const insert = db.insert(control).values({ organizationId: tenantA, name: "Smuggled" });

    expect(await rejectedWith(insert)).toBe(insufficientPrivilege);
  });
});

describe("withOrganization", () => {
  it("shows only the organization's own rows", async () => {
    const rows = await withOrganization(db, tenantA, (tx) => tx.select().from(control));

    expect(rows.map((row) => row.name)).toEqual(["Access review"]);
  });

  it("hides another organization's row from a read by id", async () => {
    const rows = await withOrganization(db, tenantB, (tx) =>
      tx.select().from(control).where(eq(control.id, controlA)),
    );

    expect(rows).toEqual([]);
  });

  it("silently changes nothing when another organization updates by id", async () => {
    // An UPDATE cannot see the row, so it matches nothing. The caller learns
    // this from the empty result, not from an error — which is the correct
    // shape: a tenant should not be able to probe for another's identifiers.
    const updated = await withOrganization(db, tenantB, (tx) =>
      tx
        .update(control)
        .set({ name: "Renamed by Globex" })
        .where(eq(control.id, controlA))
        .returning(),
    );

    expect(updated).toEqual([]);
    const [after] = await withOrganization(db, tenantA, (tx) =>
      tx.select().from(control).where(eq(control.id, controlA)),
    );
    expect(after?.name).toBe("Access review");
  });

  it("deletes nothing when another organization deletes by id", async () => {
    const deleted = await withOrganization(db, tenantB, (tx) =>
      tx.delete(control).where(eq(control.id, controlA)).returning(),
    );

    expect(deleted).toEqual([]);
  });

  it("refuses a row labelled with another organization", async () => {
    // The forged column is the whole attack: a caller legitimately inside
    // tenant A asking the database to file a row under tenant B.
    const insert = withOrganization(db, tenantA, (tx) =>
      tx.insert(control).values({ organizationId: tenantB, name: "Planted" }),
    );

    expect(await rejectedWith(insert)).toBe(insufficientPrivilege);
  });

  it("refuses to move an existing row to another organization", async () => {
    const update = withOrganization(db, tenantA, (tx) =>
      tx.update(control).set({ organizationId: tenantB }).where(eq(control.id, controlA)),
    );

    expect(await rejectedWith(update)).toBe(insufficientPrivilege);
  });

  it("writes rows the organization can then read", async () => {
    await withOrganization(db, tenantA, (tx) =>
      tx.insert(control).values({ organizationId: tenantA, name: "Backup restore test" }),
    );

    const rows = await withOrganization(db, tenantA, (tx) => tx.select().from(control));
    expect(rows.map((row) => row.name).sort()).toEqual(["Access review", "Backup restore test"]);
  });

  it("leaves no context behind for the next transaction", async () => {
    // The connection is pooled and reused, so a leaked setting would hand the
    // next request another tenant's rows.
    await withOrganization(db, tenantA, async (tx) => tx.select().from(control));

    expect(await visibleControls()).toEqual([]);
  });

  it("leaves no context behind when the transaction rolls back", async () => {
    const failed = withOrganization(db, tenantA, async () => {
      throw new Error("work failed");
    });

    await expect(failed).rejects.toThrow("work failed");
    expect(await visibleControls()).toEqual([]);
  });

  it("rolls back the work it wrapped", async () => {
    const before = await withOrganization(db, tenantA, (tx) => tx.select().from(control));

    const failed = withOrganization(db, tenantA, async (tx) => {
      await tx.insert(control).values({ organizationId: tenantA, name: "Abandoned" });
      throw new Error("work failed");
    });
    await expect(failed).rejects.toThrow("work failed");

    const after = await withOrganization(db, tenantA, (tx) => tx.select().from(control));
    expect(after).toHaveLength(before.length);
  });

  it("refuses to nest, leaving the outer transaction on its own tenant", async () => {
    // A savepoint does not scope SET LOCAL: were this allowed, releasing the
    // inner savepoint would leave tenant B in force and the rest of the outer
    // transaction would quietly read and write as the wrong tenant.
    const rows = await withOrganization(db, tenantA, async (tx) => {
      // @ts-expect-error a transaction is not a handle `withOrganization` takes
      await expect(withOrganization(tx, tenantB, async () => undefined)).rejects.toThrow(
        /cannot nest/,
      );
      return tx.select().from(control);
    });

    expect(rows.every((row) => row.organizationId === tenantA)).toBe(true);
  });

  it("binds the organization rather than interpolating it", async () => {
    // A value that would end the statement if it were pasted into the SQL.
    const injected = 'org_x\'; drop table "control"; --';

    const rows = await withOrganization(db, injected, (tx) => tx.select().from(control));

    expect(rows).toEqual([]);
    expect(await db.execute(sql`select count(*)::int as count from "control"`)).toBeDefined();
  });
});

describe("control.activated_at", () => {
  it("is stamped by the database when a control takes effect", async () => {
    const [row] = await withOrganization(db, tenantA, (tx) =>
      tx
        .insert(control)
        .values({ organizationId: tenantA, name: "Live", status: "active" })
        .returning(),
    );

    expect(row?.activatedAt).toBeInstanceOf(Date);
  });

  it("cannot be backdated on insert", async () => {
    // Only the database says when a control took effect.
    const insert = withOrganization(db, tenantA, (tx) =>
      tx.insert(control).values({
        organizationId: tenantA,
        name: "Forged",
        activatedAt: new Date("2020-01-01T00:00:00Z"),
      }),
    );

    expect(await rejectedWith(insert)).toBe(restrictViolation);
  });

  it("cannot be set on a control that never took effect", async () => {
    const update = withOrganization(db, tenantA, (tx) =>
      tx.update(control).set({ activatedAt: new Date() }).where(eq(control.id, controlA)),
    );

    expect(await rejectedWith(update)).toBe(restrictViolation);
  });

  it("cannot be supplied alongside the activation itself", async () => {
    const insert = withOrganization(db, tenantA, (tx) =>
      tx.insert(control).values({
        organizationId: tenantA,
        name: "Forged live",
        status: "active",
        activatedAt: new Date("2020-01-01T00:00:00Z"),
      }),
    );

    expect(await rejectedWith(insert)).toBe(restrictViolation);
  });

  it("cannot be cleared once stamped", async () => {
    // Clearing it would let a control that was in effect pass as a draft, and
    // the DELETE policy admits drafts.
    const cleared = withOrganization(db, tenantA, async (tx) => {
      const [row] = await tx
        .insert(control)
        .values({ organizationId: tenantA, name: "Once live", status: "active" })
        .returning();
      await tx
        .update(control)
        .set({ status: "draft", activatedAt: null })
        .where(eq(control.id, row!.id));
    });

    expect(await rejectedWith(cleared)).toBe(restrictViolation);
  });

  it("cannot be moved once stamped", async () => {
    const moved = withOrganization(db, tenantA, async (tx) => {
      const [row] = await tx
        .insert(control)
        .values({ organizationId: tenantA, name: "Live, then redated", status: "active" })
        .returning();
      await tx
        .update(control)
        .set({ activatedAt: new Date("2020-01-01T00:00:00Z") })
        .where(eq(control.id, row!.id));
    });

    expect(await rejectedWith(moved)).toBe(restrictViolation);
  });

  it("keeps a retired control retired", async () => {
    // A retired control keeps its stamp, so the CHECK alone would admit it
    // becoming active again; the trigger is what makes retirement final.
    const revived = withOrganization(db, tenantA, async (tx) => {
      const [row] = await tx
        .insert(control)
        .values({ organizationId: tenantA, name: "Retired for good", status: "active" })
        .returning();
      await tx.update(control).set({ status: "retired" }).where(eq(control.id, row!.id));
      await tx.update(control).set({ status: "active" }).where(eq(control.id, row!.id));
    });

    expect(await rejectedWith(revived)).toBe(restrictViolation);
  });

  it("is required of a retired control", async () => {
    // Retired means no longer in effect, so what never was cannot be.
    const insert = withOrganization(db, tenantA, (tx) =>
      tx.insert(control).values({ organizationId: tenantA, name: "Never live", status: "retired" }),
    );

    expect(await rejectedWith(insert)).toBe(checkViolation);
  });
});

describe("attested evidence", () => {
  /** Evidence on tenant A's control, attested. */
  const attested = () =>
    withOrganization(db, tenantA, async (tx) => {
      const [row] = await tx
        .insert(evidence)
        .values({
          organizationId: tenantA,
          controlId: controlA,
          title: "Signed",
          occurredAt: new Date(),
        })
        .returning();
      await tx
        .update(evidence)
        .set({ attestedAt: new Date(), attestedById: createId("user"), attestedByLabel: "Ada" })
        .where(eq(evidence.id, row!.id));
      return row!.id;
    });

  it("cannot be amended", async () => {
    const evidenceId = await attested();

    const amended = await withOrganization(db, tenantA, (tx) =>
      tx
        .update(evidence)
        .set({ title: "Rewritten" })
        .where(eq(evidence.id, evidenceId))
        .returning(),
    );

    expect(amended).toEqual([]);
  });

  it("cannot be discarded", async () => {
    const evidenceId = await attested();

    const discarded = await withOrganization(db, tenantA, (tx) =>
      tx.delete(evidence).where(eq(evidence.id, evidenceId)).returning(),
    );

    expect(discarded).toEqual([]);
  });

  it("keeps the control it names", async () => {
    // `controlA` is a draft that never took effect, so the DELETE policy
    // admits it; the restricting foreign key is what refuses.
    await attested();

    const removed = withOrganization(db, tenantA, (tx) =>
      tx.delete(control).where(eq(control.id, controlA)),
    );

    expect(await rejectedWith(removed)).toBe(restrictViolation);
  });
});

describe("attachments", () => {
  /** Evidence on tenant A's control, attested when asked. */
  const newEvidence = (attested: boolean) =>
    withOrganization(db, tenantA, async (tx) => {
      const [row] = await tx
        .insert(evidence)
        .values({
          organizationId: tenantA,
          controlId: controlA,
          title: "Minutes",
          occurredAt: new Date(),
        })
        .returning();
      if (attested) {
        await tx
          .update(evidence)
          .set({ attestedAt: new Date(), attestedById: createId("user"), attestedByLabel: "Ada" })
          .where(eq(evidence.id, row!.id));
      }
      return row!.id;
    });

  const attach = (evidenceId: string) =>
    withOrganization(db, tenantA, (tx) =>
      tx
        .insert(file)
        .values({
          organizationId: tenantA,
          evidenceId,
          filename: "minutes.pdf",
          contentType: "application/pdf",
          bytes: 1,
          checksum: "a".repeat(64),
        })
        .returning(),
    );

  it("attach to evidence nobody has attested", async () => {
    expect(await attach(await newEvidence(false))).toHaveLength(1);
  });

  it("are refused on attested evidence", async () => {
    expect(await rejectedWith(attach(await newEvidence(true)))).toBe(restrictViolation);
  });

  it("are refused on another organization's evidence", async () => {
    const evidenceId = await newEvidence(false);

    const insert = withOrganization(db, tenantB, (tx) =>
      tx.insert(file).values({
        organizationId: tenantB,
        evidenceId,
        filename: "smuggled.pdf",
        contentType: "application/pdf",
        bytes: 1,
        checksum: "a".repeat(64),
      }),
    );

    expect(await rejectedWith(insert)).toBe(restrictViolation);
  });

  it("cannot be smuggled past the check with a table of the same name", async () => {
    // Unqualified names resolve in `pg_temp` first, and any role may create
    // temporary tables by default. A trigger that said `evidence` rather than
    // `public.evidence` would lock this impostor and let the real, attested
    // row gain a file.
    const evidenceId = await newEvidence(true);

    const smuggled = withOrganization(db, tenantA, async (tx) => {
      await tx.execute(
        sql.raw(`create temporary table "evidence" (
          "id" text, "organization_id" text, "attested_at" timestamptz
        ) on commit drop`),
      );
      await tx.execute(
        sql`insert into pg_temp."evidence" values (${evidenceId}, ${tenantA}, null)`,
      );
      return tx.insert(file).values({
        organizationId: tenantA,
        evidenceId,
        filename: "smuggled.pdf",
        contentType: "application/pdf",
        bytes: 1,
        checksum: "a".repeat(64),
      });
    });

    expect(await rejectedWith(smuggled)).toBe(restrictViolation);
  });

  it("are never detached", async () => {
    const evidenceId = await newEvidence(false);
    const [attached] = await attach(evidenceId);

    const deleted = await withOrganization(db, tenantA, (tx) =>
      tx.delete(file).where(eq(file.id, attached!.id)).returning(),
    );

    // Matched nothing, rather than removed: the row is still there.
    expect(deleted).toEqual([]);
    const kept = await withOrganization(db, tenantA, (tx) =>
      tx.select().from(file).where(eq(file.id, attached!.id)),
    );
    expect(kept).toHaveLength(1);
  });
});

describe("control_requirement", () => {
  it("is never rewritten in place", async () => {
    // Made or unmade, never moved: a link rewritten in place would change
    // what a control answers to without either end hearing about it.
    const updated = await withOrganization(db, tenantA, async (tx) => {
      const [issue] = await tx
        .insert(standard)
        .values({ organizationId: tenantA, name: "ISO 9001", edition: "2015" })
        .returning();
      const [first, second] = await tx
        .insert(requirement)
        .values([
          {
            organizationId: tenantA,
            standardId: issue!.id,
            reference: "7.5.2",
            title: "Creating",
            position: 1,
          },
          {
            organizationId: tenantA,
            standardId: issue!.id,
            reference: "7.5.3",
            title: "Control",
            position: 2,
          },
        ])
        .returning();
      await tx
        .insert(controlRequirement)
        .values({ organizationId: tenantA, controlId: controlA, requirementId: first!.id });

      return tx
        .update(controlRequirement)
        .set({ requirementId: second!.id })
        .where(eq(controlRequirement.controlId, controlA))
        .returning();
    });

    expect(updated).toEqual([]);
  });
});

describe("audit_event", () => {
  /** An event with its attribution overridden, recorded in tenant A. */
  const record = (actor: Partial<typeof auditEvent.$inferInsert>) =>
    withOrganization(db, tenantA, (tx) =>
      tx.insert(auditEvent).values({
        organizationId: tenantA,
        actorType: "user",
        actorId: createId("user"),
        action: "updated",
        resourceType: "control",
        resourceId: controlA,
        ...actor,
      }),
    );

  it("records a user by identifier", async () => {
    await expect(record({})).resolves.toBeDefined();
  });

  it.each([
    ["a list", { after: [] }],
    ["a bare value", { before: 42 }],
  ])("refuses %s as the fields that changed", async (_case, change) => {
    const recorded = record(change as unknown as Partial<typeof auditEvent.$inferInsert>);

    expect(await rejectedWith(recorded)).toBe(checkViolation);
  });

  it("records the system without one", async () => {
    await expect(record({ actorType: "system", actorId: null })).resolves.toBeDefined();
  });

  it.each([
    ["no user at all", { actorId: null }],
    ["an identifier that is not a user's", { actorId: "" }],
    ["a label for nobody", { onBehalfOfId: null, onBehalfOfLabel: "Ada" }],
    ["somebody who is not a user", { onBehalfOfId: "" }],
    ["the system under some name", { actorType: "system" as const, actorId: "cron" }],
  ])("refuses attribution to %s", async (_case, actor) => {
    // A CHECK passes when its expression is NULL, so the missing identifiers
    // are the cases most worth pinning.
    expect(await rejectedWith(record(actor))).toBe(checkViolation);
  });
});

describe("removing a tenant", () => {
  it("deletes signed evidence, its control and its history with the organization", async () => {
    // An operator's act, never the server's (ADR 0014), but one that must work:
    // `evidence` restricts deleting its control, and the organization cascades
    // into both. PostgreSQL has to settle the two branches without the
    // restriction refusing a control whose evidence is going too.
    await db.$client.exec("reset role;");
    try {
      const [tenant] = await db
        .insert(organization)
        .values({ name: "Initech", slug: createId("organization") })
        .returning();
      const organizationId = tenant!.id;
      const [live] = await db
        .insert(control)
        .values({ organizationId, name: "TPS reports", status: "active" })
        .returning();
      const [signed] = await db
        .insert(evidence)
        .values({
          organizationId,
          controlId: live!.id,
          title: "Cover sheet",
          occurredAt: new Date(),
        })
        .returning();
      await db.insert(file).values({
        organizationId,
        evidenceId: signed!.id,
        filename: "cover.pdf",
        contentType: "application/pdf",
        bytes: 1,
        checksum: "a".repeat(64),
      });
      await db
        .update(evidence)
        .set({ attestedAt: new Date(), attestedById: createId("user"), attestedByLabel: "Bill" })
        .where(eq(evidence.id, signed!.id));
      await db.insert(auditEvent).values({
        organizationId,
        actorType: "user",
        actorId: createId("user"),
        action: "attested",
        resourceType: "evidence",
        resourceId: signed!.id,
      });

      await db.delete(organization).where(eq(organization.id, organizationId));

      for (const table of [control, evidence, file, auditEvent]) {
        const left = await db.select().from(table).where(eq(table.organizationId, organizationId));
        expect(left).toEqual([]);
      }
    } finally {
      await db.$client.exec(`set role ${applicationRole};`);
    }
  });
});
