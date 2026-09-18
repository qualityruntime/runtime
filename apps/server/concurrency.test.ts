// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Races, against a real PostgreSQL.
 *
 * PGlite uses a single connection, so it cannot exercise contention between
 * transactions. This suite uses separate PostgreSQL connections to verify
 * decisions made after waiting for locks and tenant isolation across pool reuse.
 *
 * Lock-race tests force the interleaving: a second session holds a row lock,
 * the request waits, and the second session may change the row before
 * releasing it. The waiting request must decide from the state it finds after
 * the wait.
 *
 * Skipped unless `TEST_DATABASE_URL` is set, so `bun run test` still needs
 * nothing running. It names a database this file *wipes*, so it refuses one
 * whose name does not end in `_test`.
 */

import { fileURLToPath } from "node:url";
import { createDatabase, schema } from "@qualityruntime/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

// The test runner does not read the repository's `.env`, and this is the one
// suite that needs something out of it. Optional, as it is for drizzle-kit:
// no file and no variable simply means these tests do not run.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/** The role the application connects as: owns nothing, bypasses nothing. */
const runtime = "qualityruntime_races";

// Races wait on each other by design, and `blocked` gives a request up to
// fifteen seconds to join a lock queue. The default five-second test timeout
// cut that short whenever the whole suite was running beside this file.
// A real hang still fails, and a deadlock is an error PostgreSQL raises.
vi.setConfig({ testTimeout: 30_000 });

/** How many connections the application pool may open, and so may leave dirty. */
const connections = 8;

const connectionString = process.env.TEST_DATABASE_URL;

/**
 * Unset means skip; set and unusable means stop.
 *
 * Only the first is silent, and deliberately so — `bun run test` needs nothing
 * running. Treating the second as a skip too would be the worst of both: a
 * developer who pointed this at the wrong database would see a green suite
 * that tested none of it, which is exactly the failure this file exists to end.
 */
if (connectionString) {
  const named = new URL(connectionString).pathname.slice(1);
  if (!named.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL names "${named}", and this suite wipes the database it is given. ` +
        `Point it at one whose name ends in "_test".`,
    );
  }
}
const usable = Boolean(connectionString);

let admin: Pool;
/** The one connection holding the suite's lock, from before setup to after teardown. */
let lockHolder: PoolClient;
let pool: Pool;
let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof createDatabase>;

type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
type Request = Omit<RequestInit, "headers"> & { headers?: Record<string, string> };

const request = (path: string, init: Request = {}) =>
  app.request(`/api/v1/organizations/${acme.organizationId}${path}`, {
    ...init,
    headers: {
      cookie: acme.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

/** A held lock, and a way to wait for the requests piling up behind it. */
type Held = {
  session: PoolClient;
  /** Resolves once `waiters` backends are blocked *by this session*. */
  blocked: (waiters?: number) => Promise<void>;
};

/**
 * Runs `act` against a row this holds locked, releasing only when it says so.
 *
 * `act` starts its requests, waits for them to block, makes its change and
 * commits — so each request is released into a world that moved under it.
 *
 * Waiting on the block is the part that makes any of this a test. Starting a
 * request only schedules it: without this, the other session can finish before
 * the handler has touched the database, the two never overlap, and every test
 * passes whether or not the lock it was written for exists. And it has to be a
 * wait for *this* lock — anything else waiting anywhere in the database would
 * otherwise do, which is the same false negative wearing a disguise.
 */
async function holding<T>(
  lock: string,
  parameters: unknown[],
  act: (held: Held) => Promise<T>,
): Promise<T> {
  const session = await admin.connect();
  try {
    await session.query("begin");
    await session.query(lock, parameters);
    const { rows } = await session.query<{ pid: number }>("select pg_backend_pid() as pid");
    const holder = rows[0]!.pid;

    const blocked = async (waiters = 1) => {
      // Generous on purpose: these block in milliseconds when the machine is idle,
      // and a suite that fails because it was busy is worse than a slow one.
      for (let attempt = 0; attempt < 1500; attempt++) {
        // Following the chain, not just the first link: waiters queue behind
        // each other, so the second one's `pg_blocking_pids` names the first
        // waiter rather than the session actually holding the row.
        const { rows: waiting } = await admin.query<{ waiting: number }>(
          `with recursive queue as (
             select pid from pg_stat_activity
              where datname = current_database() and $1 = any(pg_blocking_pids(pid))
             union
             select behind.pid from pg_stat_activity behind, queue
              where behind.datname = current_database()
                and queue.pid = any(pg_blocking_pids(behind.pid))
           )
           select count(*)::int as waiting from queue where pid <> $1`,
          [holder],
        );
        if ((waiting[0]?.waiting ?? 0) >= waiters) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`only some of ${waiters} request(s) ever blocked on this lock`);
    };

    return await act({ session, blocked });
  } finally {
    await session.query("rollback").catch(() => undefined);
    session.release();
  }
}

const control = async (name: string) => {
  const response = await request("/controls", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
};

beforeAll(async () => {
  if (!usable) return;

  admin = new Pool({ connectionString });

  // One runner at a time. This file wipes the schema it works in, so a second
  // run — a reviewer's, or a watch mode — would pull the tables out from under
  // the first and fail it in ways that look like real races. The lock belongs
  // to a session, so it is taken on a connection checked out for the whole
  // run: a pooled query's connection goes back to the pool, which may close it
  // when idle and release the lock mid-run. It still goes if a run is killed.
  lockHolder = await admin.connect();
  await lockHolder.query("select pg_advisory_lock(hashtext('qualityruntime concurrency suite'))");

  // A clean schema every run: these tests create rows and the database is
  // shared with whatever the last run left.
  await admin.query("drop schema if exists public cascade");
  await admin.query("create schema public");
  await admin.query("drop schema if exists drizzle cascade");

  await migrate(drizzle({ client: admin, schema, casing: "snake_case" }), { migrationsFolder });

  await admin.query(`drop role if exists ${runtime}`);
  await admin.query(`create role ${runtime} nosuperuser nobypassrls`);
  await admin.query(`grant usage on schema public to ${runtime}`);
  await admin.query(
    `grant select, insert, update, delete on all tables in schema public to ${runtime}`,
  );
  await admin.query(`revoke update, delete on "audit_event" from ${runtime}`);
  await admin.query(`revoke update, delete on "file" from ${runtime}`);
  await admin.query(`revoke update on "control_requirement" from ${runtime}`);
  await admin.query(`revoke delete on "organization" from ${runtime}`);

  // Every connection this pool hands out is the constrained role, so the
  // policies are in force exactly as they are in a deployment. More than one
  // connection, because that is the entire point of this file.
  pool = new Pool({ connectionString, max: connections, options: `-c role=${runtime}` });
  db = createDatabase(pool);
  app = createApp({
    db,
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
        name: "Ada",
        email: `${slug}@example.test`,
        password: "correct horse",
      }),
    });
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const created = await app.request("/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: slug, slug }),
    });
    expect(created.status).toBe(200);
    return { cookie, organizationId: (await json<{ id: string }>(created)).id };
  };

  acme = await tenant("acme");
  globex = await tenant("globex");
}, 120_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    // Cleanup first, then the lock: the next runner must not start while this
    // one's role is still being dropped.
    await admin.query(`drop owned by ${runtime}`).catch(() => undefined);
    await admin.query(`drop role if exists ${runtime}`).catch(() => undefined);
    await lockHolder
      ?.query("select pg_advisory_unlock(hashtext('qualityruntime concurrency suite'))")
      .catch(() => undefined);
    lockHolder?.release();
    await admin.end();
  }
});

describe.skipIf(!usable)("what a lock actually prevents", () => {
  it("decides a discard from the control as it is when the lock is granted", async () => {
    // The handler reads the control under `for update`, and the question is
    // whether it reads it *before* or *after* a change that is in flight. With
    // the lock, it waits and then sees the activated control; without it, it
    // would decide from a draft that no longer exists and delete a control
    // that had been in effect.
    const id = await control("Activated underneath");

    const response = await holding(
      `select * from "control" where "id" = $1 for update`,
      [id],
      async ({ session, blocked }) => {
        const discarding = request(`/controls/${id}`, { method: "DELETE" });
        await blocked();
        await session.query(`update "control" set "status" = 'active' where "id" = $1`, [id]);
        await session.query("commit");
        return discarding;
      },
    );

    expect(response.status).toBe(409);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("was_in_effect");
  });

  it("decides a transition from the status the lock reveals, not the one it read", async () => {
    // `draft → retired` is refused and `active → retired` allowed. The request
    // is made while the control is a draft and lands after it is active, so a
    // handler that decided from its first read would answer 409.
    const id = await control("Racing the lifecycle");

    const response = await holding(
      `select * from "control" where "id" = $1 for update`,
      [id],
      async ({ session, blocked }) => {
        const retiring = request(`/controls/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "retired" }),
        });
        await blocked();
        await session.query(`update "control" set "status" = 'active' where "id" = $1`, [id]);
        await session.query("commit");
        return retiring;
      },
    );

    expect(response.status).toBe(200);
    expect((await json<{ data: { status: string } }>(response)).data.status).toBe("retired");
  });

  it("lets two amendments through in turn, and records what each replaced", async () => {
    // Serialised rather than refused: neither names a version, so neither is
    // asking to be protected. What must not happen is an audit event claiming
    // to have replaced something it did not — the second amendment's `before`
    // has to be what the first wrote, not what it read before the first ran.
    //
    // `Promise.all` alone would not force that: it starts both requests, it
    // does not make their reads overlap. Both have to be waiting on the same
    // lock before either is let go.
    const id = await control("Original");

    const [first, second] = await holding(
      `select * from "control" where "id" = $1 for update`,
      [id],
      async ({ session, blocked }) => {
        const both = Promise.all([
          request(`/controls/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: "One" }),
          }),
          request(`/controls/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ name: "Two" }),
          }),
        ]);
        await blocked(2);
        await session.query("commit");
        return both;
      },
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    const { data } = await json<{ data: { action: string; before: { name?: string } | null }[] }>(
      await request(`/history?resource=${id}`),
    );
    const replaced = data
      .filter((event) => event.action === "updated")
      .map((event) => event.before?.name);

    expect(replaced).toHaveLength(2);
    // One replaced the original; the other replaced whatever the first wrote.
    expect(replaced).toContain("Original");
    expect(new Set(replaced).size).toBe(2);
  });
});

describe.skipIf(!usable)("tenants sharing a connection pool", () => {
  /** Lists a tenant's controls as that tenant. */
  const listing = async (who: Tenant) => {
    const response = await app.request(`/api/v1/organizations/${who.organizationId}/controls`, {
      headers: { cookie: who.cookie },
    });
    expect(response.status).toBe(200);
    return json<{ data: { id: string; organizationId: string }[] }>(response);
  };

  it("never shows one organization a connection another just used", async () => {
    // The tenant is a transaction-local setting on a pooled connection, and
    // until now there was no pool: PGlite is one connection, so a request could
    // not inherit one another had just finished with. This is the first thing
    // that can tell whether `set_config(…, true)` really is scoped the way
    // every policy depends on (ADR 0003).
    const mine = await control("Acme's own");
    const theirs = await app.request(`/api/v1/organizations/${globex.organizationId}/controls`, {
      method: "POST",
      headers: { cookie: globex.cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Globex's own" }),
    });
    expect(theirs.status).toBe(201);
    const theirControl = (await json<{ data: { id: string } }>(theirs)).data.id;

    // Enough interleaved requests to hand every connection to both tenants in
    // turn, several times over.
    const pages = await Promise.all(
      Array.from({ length: 40 }, (_, turn) => listing(turn % 2 === 0 ? acme : globex)),
    );

    for (const [turn, page] of pages.entries()) {
      const who = turn % 2 === 0 ? acme : globex;
      expect(page.data.every((row) => row.organizationId === who.organizationId)).toBe(true);
      const ids = page.data.map((row) => row.id);
      expect(ids).toContain(who === acme ? mine : theirControl);
      expect(ids).not.toContain(who === acme ? theirControl : mine);
    }
  });

  it("leaves no tenant behind on a connection it has finished with", async () => {
    // A query that forgot to open a tenant context must see nothing, even on a
    // connection that has just served twenty requests for one. `set_config(…,
    // true)` is transaction-local, so the setting is spent — but PostgreSQL
    // leaves it as the empty string rather than unsetting it, and what matters
    // is that no row's organization can ever equal that (ADR 0003).
    await Promise.all(Array.from({ length: 20 }, () => listing(acme)));

    // Every connection, not one: `pool.query` hands back whichever is free, so
    // a tenant left behind on any other would go unseen. They are checked out
    // together so that each is a different one.
    const held = await Promise.all(Array.from({ length: connections }, () => pool.connect()));
    try {
      for (const connection of held) {
        const { rows: leftover } = await connection.query<{ left: string | null }>(
          "select current_setting('qualityruntime.organization_id', true) as left",
        );
        // Transaction-local, so the setting is spent. PostgreSQL leaves it as
        // the empty string rather than unsetting it, and what matters is that
        // no row's organization can equal that (ADR 0003).
        expect(leftover[0]?.left ?? "").toBe("");

        const { rows: visible } = await connection.query<{ seen: number }>(
          'select count(*)::int as seen from "control"',
        );
        expect(visible[0]?.seen).toBe(0);
      }
    } finally {
      for (const connection of held) connection.release();
    }
  });
});
