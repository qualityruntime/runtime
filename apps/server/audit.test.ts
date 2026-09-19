// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit history: that control changes are recorded, attributed, and cannot be
 * altered afterwards (AUDIT-01).
 *
 * Changes are made over HTTP, the way they really are; the history is read back
 * through a tenant context, because the policies are what decide it is
 * readable. Requests run as a non-superuser role that owns the tables, with
 * row-level security forced so the policies bind their owner. That exercises
 * the policies; the deployment's own posture — a runtime role that owns
 * nothing — is `privileges.test.ts` and `documented-setup.test.ts`.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { fileStoreOnDisk } from "./storage-on-disk.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

/** A store of its own, thrown away with the run. */
const temporaryStore = async () =>
  fileStoreOnDisk(await mkdtemp(join(tmpdir(), "qualityruntime-")));

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let db: ReturnType<typeof createTestDatabase>;
let app: ReturnType<typeof createApp>;

type Tenant = { cookie: string; organizationId: string; userId: string };
let acme: Tenant;
let globex: Tenant;

type Control = { id: string; name: string; description: string | null; status: string };

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const request = (
  tenant: Tenant,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}/controls${path}`, {
    ...init,
    // Merged, not replaced: a caller's own headers are the point of
    // passing them, and dropping them silently makes a test pass for
    // the wrong reason.
    headers: {
      cookie: tenant.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

/** A request to the organization itself, rather than to its controls. */
const organization = (
  tenant: Tenant,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
    ...init,
    headers: { cookie: tenant.cookie, ...init.headers },
  });

async function given(tenant: Tenant, body: unknown = { name: "Access review" }): Promise<Control> {
  const response = await request(tenant, "", { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return (await json<{ data: Control }>(response)).data;
}

/** Signs a user up and returns their id and session cookie. */
async function signUp(name: string, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct horse" }),
  });
  expect(response.status).toBe(200);
  return {
    userId: (await json<{ user: { id: string } }>(response)).user.id,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
  };
}

const patch = (tenant: Tenant, id: string, body: unknown) =>
  request(tenant, `/${id}`, { method: "PATCH", body: JSON.stringify(body) });

/** The history of one resource, newest first, read through the tenant context. */
const historyOf = (tenant: Tenant, resourceId: string) =>
  withOrganization(db, tenant.organizationId, (tx) =>
    tx
      .select()
      .from(schema.auditEvent)
      .where(
        and(
          eq(schema.auditEvent.resourceType, "control"),
          eq(schema.auditEvent.resourceId, resourceId),
        ),
      )
      .orderBy(desc(schema.auditEvent.createdAt), desc(schema.auditEvent.id)),
  );

beforeAll(async () => {
  const client = new PGlite();
  db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  app = createApp({
    db,
    store: await temporaryStore(),
    auth: createAuth(db, {
      baseURL: "http://localhost",
      secret: "test-secret-of-at-least-32-characters",
    }),
  });

  const tenant = async (slug: string): Promise<Tenant> => {
    const signedUp = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada Lovelace",
        email: `${slug}@example.test`,
        password: "correct horse",
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const userId = (await json<{ user: { id: string } }>(signedUp)).user.id;
    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: slug, slug }),
    });
    expect(created.status).toBe(200);
    return { cookie, userId, organizationId: (await json<{ id: string }>(created)).id };
  };

  acme = await tenant("acme");
  globex = await tenant("globex");

  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

describe("recording a change", () => {
  it("records the creation of a control", async () => {
    const created = await given(acme, { name: "Quarterly access review" });

    const [event, ...rest] = await historyOf(acme, created.id);

    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      action: "created",
      resourceType: "control",
      resourceId: created.id,
      organizationId: acme.organizationId,
      before: null,
      after: { name: "Quarterly access review", description: null, status: "draft" },
    });
  });

  it("attributes the change to the caller, by id and by name", async () => {
    const created = await given(acme, { name: "Attributed" });

    const [event] = await historyOf(acme, created.id);

    expect(event).toMatchObject({
      actorType: "user",
      actorId: acme.userId,
      actorLabel: "Ada Lovelace",
    });
  });

  it("attributes an impersonated change to the administrator", async () => {
    // Better Auth's admin plugin can put an administrator in a member's
    // session, recording who on `session.impersonatedBy`. Set directly here:
    // what is under test is who the change is attributed to, not the plugin's
    // route. The administrator is accountable, so they are the actor; the
    // member is whose account it happened through.
    const administrator = await signUp("Grace Hopper", "administrator@example.test");
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = ${administrator.userId}
            where "user_id" = ${acme.userId}`,
      ),
    );

    const created = await given(acme, { name: "Done on their behalf" });

    const [event] = await historyOf(acme, created.id);
    expect(event).toMatchObject({
      actorType: "user",
      actorId: administrator.userId,
      // Named, so the event still says who once their account is gone.
      actorLabel: "Grace Hopper",
      onBehalfOfId: acme.userId,
      onBehalfOfLabel: "Ada Lovelace",
    });

    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = null where "user_id" = ${acme.userId}`,
      ),
    );
  });

  it("times an event when it happens, not when its transaction began", async () => {
    // `now()` is fixed for a whole transaction, so two events written in one
    // would share a timestamp — and two requests racing on the same record
    // would be ordered by when they started rather than by what happened
    // first. `clock_timestamp()` is what makes these differ. Counted in SQL
    // because a JavaScript Date rounds the difference away.
    const resourceId = "ctl_0000000000000001";
    const distinct = await withOrganization(db, acme.organizationId, async (tx) => {
      for (const action of ["created", "updated"]) {
        // The clock has to move between them for this to mean anything, and
        // two inserts alone can land inside the same microsecond.
        await tx.execute(sql`select pg_sleep(0.005)`);
        await tx.insert(schema.auditEvent).values({
          organizationId: acme.organizationId,
          actorType: "system",
          actorId: null,
          actorLabel: "a scheduled job",
          action,
          resourceType: "control",
          resourceId,
          after: {},
        });
      }
      const result = await tx.execute(
        sql`select count(distinct "created_at")::int as n from "audit_event"
            where "resource_id" = ${resourceId}`,
      );
      return (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
    });

    expect(distinct).toBe(2);
  });

  it("records only the fields an update changed", async () => {
    const created = await given(acme, { name: "Before", description: "Unchanged" });

    expect(
      (await patch(acme, created.id, { name: "After", description: "Unchanged" })).status,
    ).toBe(200);

    const [event] = await historyOf(acme, created.id);
    expect(event?.action).toBe("updated");
    expect(event?.before).toEqual({ name: "Before" });
    expect(event?.after).toEqual({ name: "After" });
  });

  it("records a status change", async () => {
    const created = await given(acme, { name: "Promoted" });

    await patch(acme, created.id, { status: "active" });

    const [event] = await historyOf(acme, created.id);
    expect(event?.before).toEqual({ status: "draft" });
    expect(event?.after).toEqual({ status: "active" });
  });

  it("records nothing when an update changes nothing", async () => {
    const created = await given(acme, { name: "Same" });

    expect((await patch(acme, created.id, { name: "Same" })).status).toBe(200);

    // Only the creation. A no-op request would otherwise bury real changes.
    const history = await historyOf(acme, created.id);
    expect(history.map((event) => event.action)).toEqual(["created"]);
  });

  it("accumulates one event per change", async () => {
    const created = await given(acme, { name: "Busy" });

    await patch(acme, created.id, { name: "Busier" });
    await patch(acme, created.id, { status: "active" });

    const history = await historyOf(acme, created.id);
    expect(history.map((event) => event.action)).toEqual(["updated", "updated", "created"]);
  });
});

describe("history and the change it describes", () => {
  it("records nothing when the change is refused", async () => {
    // The transition is illegal, so the transaction returns without writing —
    // neither the control nor its history moves.
    const created = await given(acme, { name: "Refused" });

    expect((await patch(acme, created.id, { status: "retired" })).status).toBe(409);

    const history = await historyOf(acme, created.id);
    expect(history.map((event) => event.action)).toEqual(["created"]);
  });

  it("leaves no history behind when the transaction fails", async () => {
    // The audit row is written inside the same transaction as the change, so a
    // rollback has to take both. Forced here by failing after both writes.
    const created = await given(acme, { name: "Doomed" });
    const before = await historyOf(acme, created.id);

    const attempt = withOrganization(db, acme.organizationId, async (tx) => {
      await tx
        .update(schema.control)
        .set({ name: "Never" })
        .where(eq(schema.control.id, created.id));
      await tx.insert(schema.auditEvent).values({
        organizationId: acme.organizationId,
        actorType: "user",
        actorId: acme.userId,
        actorLabel: "Ada Lovelace",
        action: "updated",
        resourceType: "control",
        resourceId: created.id,
        after: { name: "Never" },
      });
      throw new Error("the change failed");
    });
    await expect(attempt).rejects.toThrow("the change failed");

    expect(await historyOf(acme, created.id)).toEqual(before);
    const { data } = await json<{ data: Control }>(await request(acme, `/${created.id}`));
    expect(data.name).toBe("Doomed");
  });
});

describe("append-only", () => {
  it("cannot be updated from inside the tenant", async () => {
    const created = await given(acme, { name: "Immutable" });
    const [event] = await historyOf(acme, created.id);

    const updated = await withOrganization(db, acme.organizationId, (tx) =>
      tx
        .update(schema.auditEvent)
        .set({ action: "rewritten" })
        .where(eq(schema.auditEvent.id, event!.id))
        .returning(),
    );

    // No UPDATE policy exists, so no row is visible to an update at all.
    expect(updated).toEqual([]);
    expect((await historyOf(acme, created.id))[0]?.action).toBe("created");
  });

  it("cannot be deleted from inside the tenant", async () => {
    const created = await given(acme, { name: "Indelible" });
    const [event] = await historyOf(acme, created.id);

    const deleted = await withOrganization(db, acme.organizationId, (tx) =>
      tx.delete(schema.auditEvent).where(eq(schema.auditEvent.id, event!.id)).returning(),
    );

    expect(deleted).toEqual([]);
    expect(await historyOf(acme, created.id)).toHaveLength(1);
  });
});

describe("append-only under a non-owning runtime role", () => {
  /**
   * The posture `docs/deployment.md` requires for audit integrity: the server
   * connects as a role that owns nothing and holds only SELECT and INSERT here.
   * Row security cannot govern TRUNCATE, and cannot restrain an owner at all,
   * so this is the configuration in which the history is protected from the
   * runtime role itself rather than only from the application's code paths.
   */
  const asRuntimeRole = async (work: () => Promise<void>) => {
    const client = db.$client;
    await client.exec(`
      reset role;
      create role qualityruntime_runtime nosuperuser nobypassrls;
      grant select, insert, update, delete on "control" to qualityruntime_runtime;
      grant select, insert on "audit_event" to qualityruntime_runtime;
      set role qualityruntime_runtime;
    `);
    try {
      await work();
    } finally {
      await client.exec(`
        reset role;
        drop owned by qualityruntime_runtime;
        drop role qualityruntime_runtime;
        set role qualityruntime_app;
      `);
    }
  };

  it("refuses TRUNCATE, which no policy can cover", async () => {
    await given(acme, { name: "Protected" });

    await asRuntimeRole(async () => {
      await expect(db.execute(sql`truncate table "audit_event"`)).rejects.toThrow();
    });

    // Still there, read back as the ordinary test role.
    const events = await withOrganization(db, acme.organizationId, (tx) =>
      tx.select().from(schema.auditEvent),
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it("refuses an update or delete outright rather than matching no rows", async () => {
    await asRuntimeRole(async () => {
      // Without the grant this is a privilege error, not the silent no-op a
      // policy produces — the difference between cannot and did not.
      await expect(db.execute(sql`update "audit_event" set "action" = 'x'`)).rejects.toThrow();
      await expect(db.execute(sql`delete from "audit_event"`)).rejects.toThrow();
    });
  });

  it("can still read and append its tenant's history", async () => {
    await asRuntimeRole(async () => {
      const created = await withOrganization(db, acme.organizationId, (tx) =>
        tx
          .insert(schema.auditEvent)
          .values({
            organizationId: acme.organizationId,
            actorType: "system",
            actorId: null,
            actorLabel: "a scheduled job",
            action: "created",
            resourceType: "control",
            resourceId: "ctl_0000000000000000",
            after: {},
          })
          .returning(),
      );

      expect(created).toHaveLength(1);
    });
  });
});

describe("tenant isolation", () => {
  it("hides one organization's history from another", async () => {
    const theirs = await given(globex, { name: "Globex only" });

    expect(await historyOf(globex, theirs.id)).toHaveLength(1);
    expect(await historyOf(acme, theirs.id)).toEqual([]);
  });

  it("refuses an event labelled with another organization", async () => {
    const attempt = withOrganization(db, acme.organizationId, (tx) =>
      tx.insert(schema.auditEvent).values({
        organizationId: globex.organizationId,
        actorType: "user",
        actorId: acme.userId,
        actorLabel: "Ada Lovelace",
        action: "created",
        resourceType: "control",
        resourceId: "ctl_0000000000000000",
        after: {},
      }),
    );

    await expect(attempt).rejects.toThrow();
  });
});

describe("reading an organization's history", () => {
  type Event = { id: string; resourceType: string; resourceId: string; action: string };
  /** Every event id an unfiltered walk of this organization's history sees. */
  async function walkHistory(query: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 40; guard++) {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const body = await json<{ data: { id: string }[]; nextCursor: string | null }>(
        await organization(acme, `/history?${query}${suffix}`),
      );
      seen.push(...body.data.map((event) => event.id));
      if (!body.nextCursor) return seen;
      cursor = body.nextCursor;
    }
    throw new Error("paging did not terminate");
  }

  const readHistory = async (tenant: Tenant, query = "") =>
    json<{ data: Event[]; nextCursor: string | null }>(
      await organization(tenant, `/history${query}`),
    );

  it("survives the record it describes", async () => {
    // The reason this collection exists. A control's history used to be
    // reachable only through the control, so discarding one put its history
    // beyond every route in the product (ADR 0018).
    const control = await given(acme, { name: "Discarded, but not forgotten" });
    expect((await request(acme, `/${control.id}`, { method: "DELETE" })).status).toBe(204);

    const { data } = await readHistory(acme, `?resource=${control.id}`);

    expect(data.map((event) => event.action).sort()).toEqual(["created", "deleted"]);
    expect(data.every((event) => event.resourceId === control.id)).toBe(true);
  });

  it("spans every kind of record, not just controls", async () => {
    const control = await given(acme, { name: "With evidence" });
    const recorded = await app.request(
      `/api/v1/organizations/${acme.organizationId}/controls/${control.id}/evidence`,
      {
        method: "POST",
        headers: { cookie: acme.cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "Minutes", occurredAt: "2026-07-01T09:00:00.000Z" }),
      },
    );
    expect(recorded.status).toBe(201);
    const evidenceId = (await json<{ data: { id: string } }>(recorded)).data.id;

    const { data } = await readHistory(acme);

    expect(data.some((event) => event.resourceId === control.id)).toBe(true);
    const theirs = data.find((event) => event.resourceId === evidenceId);
    expect(theirs?.resourceType).toBe("evidence");
  });

  it("narrows to one record by the identifier alone", async () => {
    const mine = await given(acme, { name: "Mine" });
    const other = await given(acme, { name: "Another" });

    const { data } = await readHistory(acme, `?resource=${mine.id}`);

    expect(data.every((event) => event.resourceId === mine.id)).toBe(true);
    expect(data.some((event) => event.resourceId === other.id)).toBe(false);
  });

  it("shows an organization nothing of another's", async () => {
    // The policies decide this, not the route: there is no record to look up
    // and refuse, because history outlives records.
    const theirs = await given(globex, { name: "Globex only" });

    const { data } = await readHistory(acme, `?resource=${theirs.id}`);
    const everything = await readHistory(acme);

    expect(data).toEqual([]);
    expect(everything.data.some((event) => event.resourceId === theirs.id)).toBe(false);
  });

  it("renders what happened, not just that something did", async () => {
    // The row is reshaped on the way out, so every part of that shaping is a
    // place a field can be silently dropped. Nulling `before` or the
    // impersonation attribution left the whole suite green until this.
    const administrator = await signUp("Grace Hopper", "behalf@example.test");
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = ${administrator.userId}
            where "user_id" = ${acme.userId}`,
      ),
    );
    const control = await given(acme, { name: "Before" });
    expect(
      (
        await request(acme, `/${control.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name: "After" }),
        })
      ).status,
    ).toBe(200);
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`update "session" set "impersonated_by" = null where "user_id" = ${acme.userId}`,
      ),
    );

    const { data } = await json<{
      data: {
        action: string;
        actor: {
          id: string;
          label: string | null;
          onBehalfOf: { id: string; label: string } | null;
        };
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }[];
    }>(await organization(acme, `/history?resource=${control.id}`));

    const change = data.find((event) => event.action === "updated");
    expect(change?.before).toEqual({ name: "Before" });
    expect(change?.after).toEqual({ name: "After" });
    // The administrator is accountable; the member is whose account it went
    // through. Both survive the reshaping.
    expect(change?.actor.id).toBe(administrator.userId);
    expect(change?.actor.label).toBe("Grace Hopper");
    expect(change?.actor.onBehalfOf).toEqual({ id: acme.userId, label: "Ada Lovelace" });

    const creation = data.find((event) => event.action === "created");
    expect(creation?.before).toBeNull();
  });

  it("answers 404 to a caller who is not a member, as every other collection does", async () => {
    // The organization is still resolved before the handler runs. Removing the
    // record lookup removed record-level absences, not this one.
    const theirs = await app.request(`/api/v1/organizations/${globex.organizationId}/history`, {
      headers: { cookie: acme.cookie },
    });

    expect(theirs.status).toBe(404);
  });

  it("pages the unfiltered history without repeating or skipping, even on a tie", async () => {
    // Two mutations lived here: applying the cursor only when filtered, which
    // makes an unfiltered walk repeat its first page forever; and dropping the
    // id from the ordering, which loses rows whose timestamps are identical.
    // Neither is visible without an unfiltered walk over tied timestamps.
    const control = await given(acme, { name: "Tied" });
    const tied = ["aud_tie0000000000001", "aud_tie0000000000002", "aud_tie0000000000003"];
    await withOrganization(db, acme.organizationId, async (tx) => {
      for (const id of tied) {
        await tx.execute(
          sql`insert into "audit_event"
                ("id", "organization_id", "actor_type", "actor_id", "action",
                 "resource_type", "resource_id", "after", "created_at")
              values (${id}, ${acme.organizationId}, 'system', null, 'updated',
                      'control', ${control.id}, '{}'::jsonb,
                      '2031-01-01T00:00:00.000000Z'::timestamptz)`,
        );
      }
    });

    // Without this the index returns the rows in `(created_at, id)` order
    // whatever the query asked for, so an ordering that forgot the id would
    // still look right. Turning the index scan off is what makes the query's
    // own `ORDER BY` the thing under test rather than the planner's choice.
    await db.execute(sql`set enable_indexscan = off`);
    await db.execute(sql`set enable_bitmapscan = off`);
    let seen: string[] = [];
    try {
      seen = await walkHistory("limit=2");
    } finally {
      await db.execute(sql`reset enable_indexscan`);
      await db.execute(sql`reset enable_bitmapscan`);
    }

    expect(new Set(seen).size).toBe(seen.length);
    // The three tied rows are ordered by id and all of them come back.
    expect(seen.filter((id) => tied.includes(id))).toEqual([...tied].reverse());
  });

  it("renders a deletion and a change nobody made", async () => {
    // `after` is absent for a deletion and must stay null rather than become
    // an empty object, and an actor the product attributes to itself must not
    // be rendered as a user.
    const control = await given(acme, { name: "Short-lived" });
    expect((await request(acme, `/${control.id}`, { method: "DELETE" })).status).toBe(204);
    await withOrganization(db, acme.organizationId, (tx) =>
      tx.execute(
        sql`insert into "audit_event"
              ("id", "organization_id", "actor_type", "actor_id", "action",
               "resource_type", "resource_id", "after")
            values ('aud_system0000000000', ${acme.organizationId}, 'system', null, 'updated',
                    'control', ${control.id}, '{}'::jsonb)`,
      ),
    );

    const { data } = await json<{
      data: { action: string; actor: { type: string; id: string | null }; after: unknown }[];
    }>(await organization(acme, `/history?resource=${control.id}`));

    expect(data.find((event) => event.action === "deleted")?.after).toBeNull();
    const byNobody = data.find((event) => event.actor.type === "system");
    expect(byNobody).toBeDefined();
    expect(byNobody?.actor.id).toBeNull();
  });

  it("refuses a cursor from a differently-filtered history", async () => {
    // A cursor is a position in an ordering, and narrowing the history makes a
    // different one: the same position names different rows (ADR 0006).
    const control = await given(acme, { name: "Cursor crossing" });
    const narrowed = await readHistory(acme, `?resource=${control.id}&limit=1`);
    const whole = await readHistory(acme, "?limit=1");
    expect(whole.nextCursor).not.toBeNull();

    const crossed = await organization(
      acme,
      `/history?resource=${control.id}&cursor=${encodeURIComponent(whole.nextCursor!)}`,
    );

    expect(narrowed.nextCursor).not.toBe(whole.nextCursor);
    expect(crossed.status).toBe(400);
  });
});
