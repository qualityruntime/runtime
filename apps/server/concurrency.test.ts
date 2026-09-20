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

import { createDatabase, schema, withOrganization } from "@qualityruntime/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createApp } from "./app.ts";
import { maxFilesPerEvidence } from "./files.ts";
import { createAuth } from "./auth.ts";
import { objectStoreInS3 } from "./objects-in-s3.ts";
import { gracePeriod, reclaimStorage } from "./reclaim.ts";
import type { ObjectStore } from "./objects.ts";
import { completeUpload, inMemoryObjectStore, uploadedBytes } from "./s3-in-memory.ts";

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
/** The bucket the store writes to, so orphaned bytes can be counted. */
let storage: ReturnType<typeof inMemoryObjectStore>;

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

/** How many permanent objects the bucket holds: one per file that survived. */
const stored = () => [...storage.objects.keys()].filter((key) => key.startsWith("files/")).length;

/** An upload prepared and sent, ready for the completion a test is about to race. */
const uploaded = (evidenceId: string, filename: string) =>
  uploadedBytes(storage, request, evidenceId, `bytes for ${filename}`, { filename });

const control = async (name: string) => {
  const response = await request("/controls", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
};

/**
 * Two of acme's requirements, importing a standard the first time. Each test
 * asks for its own rather than relying on one that ran before it, so a test
 * picked out with `-t` still has what it needs.
 */
const requirements = async (): Promise<[string, string]> => {
  const held = () =>
    admin.query<{ id: string }>(
      `select "id" from "requirement" where "organization_id" = $1 order by "id" limit 2`,
      [acme.organizationId],
    );
  let { rows } = await held();
  if (rows.length < 2) {
    const imported = await request("/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 9001",
        edition: "2015",
        requirements: [
          { reference: "7.5.1", title: "General" },
          { reference: "7.5.3", title: "Documented information" },
        ],
      }),
    });
    expect(imported.status).toBe(201);
    ({ rows } = await held());
  }
  return [rows[0]!.id, rows[1]!.id];
};

const evidenceFor = async (controlId: string, title: string) => {
  const response = await request(`/controls/${controlId}/evidence`, {
    method: "POST",
    body: JSON.stringify({ title, occurredAt: "2026-07-01T09:00:00.000Z" }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
};

const tagOf = async (path: string) => {
  const response = await request(path);
  expect(response.status).toBe(200);
  return response.headers.get("etag")!;
};

beforeAll(async () => {
  if (!usable) return;

  storage = inMemoryObjectStore();
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
  await admin.query(`revoke update on "file_upload" from ${runtime}`);
  await admin.query(`grant update ("file_id") on "file_upload" to ${runtime}`);
  await admin.query(`revoke delete on "organization" from ${runtime}`);

  // Every connection this pool hands out is the constrained role, so the
  // policies are in force exactly as they are in a deployment. More than one
  // connection, because that is the entire point of this file.
  pool = new Pool({ connectionString, max: connections, options: `-c role=${runtime}` });
  db = createDatabase(pool);
  app = createApp({
    db,
    store: storage.store,
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

  it("refuses a conditional discard of evidence amended while it waited", async () => {
    // The race that shipped. The tag was compared against an unlocked read, so
    // the amendment below landed between the comparison and the delete and the
    // evidence went anyway — with the caller none the wiser.
    const id = await control("For the evidence");
    const evidenceId = await evidenceFor(id, "Read, then amended");
    const read = await tagOf(`/evidence/${evidenceId}`);

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const discarding = request(`/evidence/${evidenceId}`, {
          method: "DELETE",
          headers: { "if-match": read },
        });
        await blocked();
        await session.query(`update "evidence" set "title" = 'Amended' where "id" = $1`, [
          evidenceId,
        ]);
        await session.query("commit");
        return discarding;
      },
    );

    expect(response.status).toBe(412);
    // And the evidence is still there, carrying the amendment.
    const { data } = await json<{ data: { title: string } }>(
      await request(`/evidence/${evidenceId}`),
    );
    expect(data.title).toBe("Amended");
  });

  it("refuses a conditional amendment of evidence amended while it waited", async () => {
    const id = await control("For the other amendment");
    const evidenceId = await evidenceFor(id, "Also read first");
    const read = await tagOf(`/evidence/${evidenceId}`);

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const amending = request(`/evidence/${evidenceId}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "Mine" }),
          headers: { "if-match": read },
        });
        await blocked();
        await session.query(`update "evidence" set "title" = 'Theirs' where "id" = $1`, [
          evidenceId,
        ]);
        await session.query("commit");
        return amending;
      },
    );

    expect(response.status).toBe(412);
    const { data } = await json<{ data: { title: string } }>(
      await request(`/evidence/${evidenceId}`),
    );
    expect(data.title).toBe("Theirs");
  });

  it("refuses an attestation of evidence amended while it waited", async () => {
    // Attesting takes no lock before comparing — an attested row could not be
    // locked anyway — so it repeats the version in its `UPDATE` instead. This
    // is what that repetition is for.
    const id = await control("For the signature");
    const evidenceId = await evidenceFor(id, "About to be signed");
    const read = await tagOf(`/evidence/${evidenceId}`);

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const attesting = request(`/evidence/${evidenceId}/attestation`, {
          method: "PUT",
          headers: { "if-match": read },
        });
        await blocked();
        await session.query(`update "evidence" set "title" = 'Changed first' where "id" = $1`, [
          evidenceId,
        ]);
        await session.query("commit");
        return attesting;
      },
    );

    expect(response.status).toBe(412);
    const { data } = await json<{ data: { attestation: unknown } }>(
      await request(`/evidence/${evidenceId}`),
    );
    expect(data.attestation).toBeNull();
  });

  it.each([
    ["the discard", "discard"],
    ["the recording", "record"],
  ])(
    "never both discards a control and records evidence against it, %s first",
    async (_case, first) => {
      // ADR 0013 argued this from lock conflicts and never showed it: recording
      // evidence needs `for key share` on its control for the foreign key check,
      // which conflicts with the `for update` a discard holds. So the two cannot
      // interleave — and whichever loses must lose *cleanly*, not with a foreign
      // key violation surfacing as a 500.
      //
      // Both orders, and each forced: a lock queue is first-come, so starting one
      // request and waiting for it to join the queue before starting the other
      // decides which wins. Leaving it to chance would make this pass whenever
      // the order happened to be the harmless one.
      const id = await control(`Contested ${first}`);
      const discard = () => request(`/controls/${id}`, { method: "DELETE" });
      const record = () =>
        request(`/controls/${id}/evidence`, {
          method: "POST",
          body: JSON.stringify({ title: "Racing", occurredAt: "2026-07-01T09:00:00.000Z" }),
        });

      const [discarded, recorded] = await holding(
        `select * from "control" where "id" = $1 for update`,
        [id],
        async ({ session, blocked }) => {
          const ahead = first === "discard" ? discard() : record();
          await blocked(1);
          const behind = first === "discard" ? record() : discard();
          await blocked(2);
          await session.query("commit");
          const settled = await Promise.all([ahead, behind]);
          return first === "discard" ? settled : [settled[1]!, settled[0]!];
        },
      );

      // Neither is a server error, whichever went first.
      expect(discarded.status).not.toBe(500);
      expect(recorded.status).not.toBe(500);

      const gone = (await request(`/controls/${id}`)).status === 404;
      if (first === "discard") {
        // The discard was ahead, so it took the control and the recording found
        // nothing to record against.
        expect(discarded.status).toBe(204);
        expect(gone).toBe(true);
        expect(recorded.status).toBe(404);
      } else {
        // The recording was ahead, so the control now carries evidence and may
        // not be discarded at all.
        expect(recorded.status).toBe(201);
        expect(gone).toBe(false);
        expect(discarded.status).toBe(409);
        expect((await json<{ error: { code: string } }>(discarded)).error.code).toBe(
          "has_evidence",
        );
      }
    },
  );

  it.each([
    ["the discard", "discard"],
    ["the attachment", "attach"],
  ])("never both discards evidence and attaches a file to it, %s first", async (_case, first) => {
    // The same shape one level down: a file references its evidence, so the
    // insert needs `for key share` on it, and a discard holds `for update`.
    const id = await control(`Contested attachment ${first}`);
    const evidenceId = await evidenceFor(id, "Gaining or losing a file");
    const discard = () => request(`/evidence/${evidenceId}`, { method: "DELETE" });
    // Prepared and sent before the lock is taken, so what races the discard is
    // the completion — the only step that writes.
    const uploadId = await uploaded(evidenceId, "racing.txt");
    const attach = () => completeUpload(request, uploadId);

    const before = stored();
    const [discarded, attached] = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const ahead = first === "discard" ? discard() : attach();
        await blocked(1);
        const behind = first === "discard" ? attach() : discard();
        await blocked(2);
        await session.query("commit");
        const settled = await Promise.all([ahead, behind]);
        return first === "discard" ? settled : [settled[1]!, settled[0]!];
      },
    );

    expect(discarded.status).not.toBe(500);
    expect(attached.status).not.toBe(500);

    const survives = (await request(`/evidence/${evidenceId}`)).status === 200;
    if (first === "discard") {
      // The evidence went, so there was nothing left to attach to.
      expect(discarded.status).toBe(204);
      expect(survives).toBe(false);
      expect(attached.status).not.toBe(200);
      // The object was promoted before the row was attempted, and the row never
      // landed — so it has to go now, while the outcome is known. Left behind
      // it would be invisible to `verify:files`, which starts from file rows,
      // and would wait for the next `reclaim:storage` (ADR 0021).
      expect(stored()).toBe(before);
    } else {
      // The file landed first; discarding evidence takes its files with it,
      // which is the documented cascade rather than a race (ADR 0021).
      expect(attached.status).toBe(200);
      expect(discarded.status).toBe(204);
      expect(survives).toBe(false);
      // The file row went with its evidence, and its bytes stayed: a foreign
      // key cannot reach a bucket, so they wait for `reclaim:storage`
      // (ADR 0021).
      expect(stored()).toBe(before + 1);
    }
  });

  it("says attested, not missing, when evidence is signed while an upload completes", async () => {
    // A locked read is governed by the UPDATE policy, which sees only
    // unattested rows. So evidence attested while the bytes were being checked
    // is not there to lock — and without a second, unlocked read that arrives
    // as 404 rather than 409, telling a caller the evidence never existed.
    const id = await control("Signed mid-upload");
    const evidenceId = await evidenceFor(id, "About to be signed");
    const uploadId = await uploaded(evidenceId, "late.txt");
    const { rows } = await admin.query<{ id: string }>('select "id" from "user" limit 1');
    const signer = rows[0]!.id;

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const attaching = completeUpload(request, uploadId);
        await blocked(1);
        await session.query(
          `update "evidence" set "attested_at" = now(), "attested_by_id" = $2,
             "attested_by_label" = 'Ada' where "id" = $1`,
          [evidenceId, signer],
        );
        await session.query("commit");
        return attaching;
      },
    );

    expect(response.status).toBe(409);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("already_attested");
  });

  it("keeps the promoted bytes when the transaction fails, for the sweep to find", async () => {
    // The losing paths above all *return* an outcome, and remove what they
    // promoted. This is the other branch: the transaction throws, and nothing
    // here can tell a rollback from a commit whose acknowledgement was lost —
    // so the bytes stay. Forced by taking away the privilege the audit write
    // needs, which is a real PostgreSQL error raised mid-transaction.
    const id = await control("Failing mid-transaction");
    const evidenceId = await evidenceFor(id, "Its audit write will fail");
    const uploadId = await uploaded(evidenceId, "doomed.txt");
    const before = new Set(storage.objects.keys());

    let response: Response;
    try {
      await admin.query(`revoke insert on "audit_event" from ${runtime}`);
      response = await completeUpload(request, uploadId);
    } finally {
      await admin.query(`grant insert on "audit_event" to ${runtime}`);
    }

    expect(response.status).toBe(500);
    // Rolled back, so no row and nothing attached.
    expect((await request(`/evidence/${evidenceId}`)).status).toBe(200);
    const { data } = await json<{ data: { files: unknown[] } }>(
      await request(`/evidence/${evidenceId}`),
    );
    expect(data.files).toEqual([]);
    const promoted = [...storage.objects.keys()].filter((key) => !before.has(key));
    expect(promoted).toHaveLength(1);

    // What is left is an orphan rather than a leak: the sweep finds it and
    // removes it, a day later, because anything younger may belong to a
    // transaction still committing (ADR 0021). The attachment below is setup —
    // a database holding no files at all is what a database that is not this
    // deployment's looks like from here, and the sweep refuses that.
    expect((await completeUpload(request, await uploaded(evidenceId, "kept.txt"))).status).toBe(
      200,
    );
    const tomorrow = new Date(Date.now() + gracePeriod + 1000);
    const swept = await reclaimStorage(db, storage.store, { remove: true, now: tomorrow });
    expect(swept.orphans.map((orphan) => orphan.key)).toContain(promoted[0]);
    expect(storage.objects.has(promoted[0]!)).toBe(false);
  });

  it("refuses a conditional remapping of a control remapped while it waited", async () => {
    // The last mutation that was last-writer-wins. A set has no `xmin`, so its
    // version is its contents — and the handler already holds `for update` on
    // the control while it replaces them, which is what makes comparing the
    // contents safe (ADR 0019).
    const id = await control("Contested requirements");
    const [first, second] = await requirements();

    const read = (await request(`/controls/${id}/requirements`)).headers.get("etag")!;

    const response = await holding(
      `select * from "control" where "id" = $1 for update`,
      [id],
      async ({ session, blocked }) => {
        const mapping = request(`/controls/${id}/requirements`, {
          method: "PUT",
          body: JSON.stringify({ requirementIds: [first] }),
          headers: { "if-match": read },
        });
        await blocked();
        // Somebody else maps it to the other requirement, and commits.
        await session.query(
          `insert into "control_requirement" ("organization_id", "control_id", "requirement_id")
           values ($1, $2, $3)`,
          [acme.organizationId, id, second],
        );
        await session.query("commit");
        return mapping;
      },
    );

    expect(response.status).toBe(412);
    // And the set the other writer left is untouched.
    const { data } = await json<{ data: { id: string }[] }>(
      await request(`/controls/${id}/requirements`),
    );
    expect(data.map((row) => row.id)).toEqual([second]);
  });

  it("refuses a mapping to a requirement deleted while it waited, rather than failing", async () => {
    // What `for key share` on the named requirements is for. Deleting the
    // standard takes its requirements by cascade and holds their rows until it
    // commits; the replacement waits on that lock and then finds them gone.
    // With a plain read it would see them, pass the check, and meet the
    // foreign key on insert instead — a 500 for what is a bad request.
    const id = await control("Answering to a doomed clause");
    const imported = await request("/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Doomed",
        edition: "1",
        requirements: [{ reference: "1", title: "Soon gone" }],
      }),
    });
    expect(imported.status).toBe(201);
    const standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const { rows } = await admin.query<{ id: string }>(
      `select "id" from "requirement" where "standard_id" = $1`,
      [standardId],
    );
    const requirementId = rows[0]!.id;

    const response = await holding(
      `delete from "standard" where "id" = $1`,
      [standardId],
      async ({ session, blocked }) => {
        const mapping = request(`/controls/${id}/requirements`, {
          method: "PUT",
          body: JSON.stringify({ requirementIds: [requirementId] }),
        });
        await blocked();
        await session.query("commit");
        return mapping;
      },
    );

    expect(response.status).toBe(400);
    const { error } = await json<{ error: { details?: { message: string }[] } }>(response);
    expect(error.details?.[0]?.message).toContain(requirementId);
  });

  it.each([
    ["one snapshot", true, "same"],
    ["a snapshot per statement", false, "different"],
  ])("reads a collection and its version from %s", async (_case, repeatableRead, expected) => {
    // Two statements in one transaction see two committed states under `read
    // committed`, which is right for a write deciding from what is stored now
    // and wrong for a read whose answers must agree: a page of a collection and
    // the version describing that collection (ADR 0019).
    const id = await control(`Snapshot ${expected}`);
    const [requirementId] = await requirements();

    const mapped = (tx: Parameters<Parameters<typeof withOrganization>[2]>[0]) =>
      tx
        .select({ requirementId: schema.controlRequirement.requirementId })
        .from(schema.controlRequirement)
        .where(eq(schema.controlRequirement.controlId, id));

    const [before, after] = await withOrganization(
      db,
      acme.organizationId,
      async (tx) => {
        const first = await mapped(tx);
        // Somebody else maps it, and commits, between the two reads.
        await admin.query(
          `insert into "control_requirement" ("organization_id", "control_id", "requirement_id")
           values ($1, $2, $3)`,
          [acme.organizationId, id, requirementId],
        );
        return [first, await mapped(tx)] as const;
      },
      { repeatableRead },
    );

    expect(before).toEqual([]);
    if (expected === "same") expect(after).toEqual(before);
    else expect(after).toHaveLength(1);
  });

  it("answers 404, not 500, when evidence is discarded while an upload is prepared", async () => {
    // Preparing reads the evidence and then inserts a `file_upload` naming it.
    // Without a lock those are two decisions about two different states: a
    // discard committing between them turns a clean 404 into a foreign key
    // violation and a 500. `for key share` is what makes the request wait and
    // then see what actually happened.
    const id = await control("Discarded as an upload is prepared");
    const evidenceId = await evidenceFor(id, "About to go");

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const preparing = request(`/evidence/${evidenceId}/file-uploads`, {
          method: "POST",
          body: JSON.stringify({ filename: "minutes.pdf" }),
        });
        await blocked();
        await session.query(`delete from "file" where "evidence_id" = $1`, [evidenceId]);
        await session.query(`delete from "evidence" where "id" = $1`, [evidenceId]);
        await session.query("commit");
        return preparing;
      },
    );

    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found");
  });

  it("refuses an attachment when evidence is attested beside it", async () => {
    // A test alone cannot decide this: under `read committed` it sees the
    // committed draft while an attestation sits uncommitted in another
    // transaction, and the `for key share` an insert's foreign key takes does
    // not conflict with that `update`. Both would commit, and what was signed
    // gains an attachment afterwards — which ADR 0012 says cannot happen.
    //
    // Driven at the SQL level, as the runtime role, with no lock of the
    // inserter's own: the guarantee is `file_evidence_open`'s, so it has to
    // hold for an insert path that remembers nothing.
    const id = await control("Signed while gaining a file");
    const evidenceId = await evidenceFor(id, "About to be signed");
    const { rows: users } = await admin.query<{ id: string }>('select "id" from "user" limit 1');
    const signer = users[0]!.id;

    const attesting = await pool.connect();
    const attaching = await pool.connect();
    try {
      await attesting.query("begin");
      await attesting.query("select set_config('qualityruntime.organization_id', $1, true)", [
        acme.organizationId,
      ]);
      // The signature, not yet committed.
      await attesting.query(
        `update "evidence" set "attested_at" = now(), "attested_by_id" = $2,
         "attested_by_label" = 'Ada' where "id" = $1`,
        [evidenceId, signer],
      );

      await attaching.query("begin");
      await attaching.query("select set_config('qualityruntime.organization_id', $1, true)", [
        acme.organizationId,
      ]);
      const { rows: backend } = await attaching.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const landing = attaching
        .query(
          `insert into "file" ("id", "organization_id", "evidence_id", "filename",
           "content_type", "bytes", "checksum")
           values ($1, $2, $3, 'racing.txt', 'text/plain', 5, $4)`,
          [`fil_${"0".repeat(16)}`, acme.organizationId, evidenceId, "a".repeat(64)],
        )
        .then(
          () => "attached",
          (error: { code?: string }) => error.code,
        );

      // Waiting on the trigger's lock, not merely slow: only then is the order
      // of the two commits what this test says it is.
      for (let attempt = 0; ; attempt++) {
        const { rows } = await admin.query<{ blocked: boolean }>(
          "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
          [backend[0]!.pid],
        );
        if (rows[0]?.blocked) break;
        if (attempt === 1500) throw new Error("the attachment never waited for the signature");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await attesting.query("commit");

      expect(await landing).toBe("23001");
    } finally {
      for (const session of [attesting, attaching]) {
        await session.query("rollback").catch(() => undefined);
        session.release();
      }
    }

    const { rows: attached } = await admin.query<{ count: number }>(
      'select count(*)::int as count from "file" where "evidence_id" = $1',
      [evidenceId],
    );
    expect(attached[0]?.count).toBe(0);
  });

  it("attaches one file when two completions of one upload arrive together", async () => {
    // The SQL-level case below proves the policy; this proves the handler
    // built on it. Both attempts promote an object of their own — neither can
    // overwrite the other's bytes — and the database picks which one becomes
    // the file. The loser has to answer with the winner's file rather than a
    // conflict, or a client retrying a lost response sees an error for
    // something that worked, and has to remove its own orphan.
    const id = await control("Completed twice over HTTP");
    const evidenceId = await evidenceFor(id, "One upload, two completions");
    const uploadId = await uploaded(evidenceId, "sent once.txt");
    const before = stored();

    const [first, second] = await Promise.all([
      completeUpload(request, uploadId),
      completeUpload(request, uploadId),
    ]);

    expect([first!.status, second!.status]).toEqual([200, 200]);
    const files = await Promise.all(
      [first!, second!].map(async (response) => json<{ data: { id: string } }>(response)),
    );
    expect(files[0]!.data.id).toBe(files[1]!.data.id);

    // One file row, and one permanent object: the loser removed what it
    // promoted rather than leaving it for `reclaim:storage` a day later. This
    // is the returned-outcome branch, where the rollback is known.
    const { rows } = await admin.query<{ count: number }>(
      'select count(*)::int as count from "file" where "evidence_id" = $1',
      [evidenceId],
    );
    expect(rows[0]?.count).toBe(1);
    expect(stored()).toBe(before + 1);
  });

  it("lets only one of two completions name the file an upload produced", async () => {
    // `file_upload_tenant_complete` tests `file_id IS NULL` in its USING
    // clause, and the whole idempotency story rests on that being re-checked
    // against the version another transaction committed rather than against
    // the snapshot this one started with. Here unlike `file_evidence_open`,
    // the row being tested *is* the row being written, so PostgreSQL locks it,
    // waits, and re-evaluates — no lock of the writer's own. That is a claim
    // about PostgreSQL, which is exactly the kind ADR 0020 exists to stop
    // anyone arguing rather than demonstrating.
    //
    // Driven at the SQL level with no `file_id is null` in the statement, so
    // what is under test is the policy and not the handler remembering.
    const id = await control("Completed twice at once");
    const evidenceId = await evidenceFor(id, "Uploaded once, completed twice");

    const uploadId = `upl_${"0".repeat(16)}`;
    const candidates = [`fil_${"1".repeat(16)}`, `fil_${"2".repeat(16)}`];
    await admin.query(
      `insert into "file_upload" ("id", "organization_id", "evidence_id", "filename",
       "content_type", "expires_at")
       values ($1, $2, $3, 'minutes.pdf', 'application/pdf', now() + interval '1 hour')`,
      [uploadId, acme.organizationId, evidenceId],
    );
    // One promoted object per attempt, as completion makes them: neither can
    // overwrite the other's bytes, and the database picks which one is the file.
    for (const fileId of candidates) {
      await admin.query(
        `insert into "file" ("id", "organization_id", "evidence_id", "filename",
         "content_type", "bytes", "checksum")
         values ($1, $2, $3, 'minutes.pdf', 'application/pdf', 5, $4)`,
        [fileId, acme.organizationId, evidenceId, "a".repeat(64)],
      );
    }

    const claim = (session: PoolClient, fileId: string) =>
      session.query('update "file_upload" set "file_id" = $2 where "id" = $1', [uploadId, fileId]);

    const winner = await pool.connect();
    const loser = await pool.connect();
    try {
      for (const session of [winner, loser]) {
        await session.query("begin");
        await session.query("select set_config('qualityruntime.organization_id', $1, true)", [
          acme.organizationId,
        ]);
      }
      expect((await claim(winner, candidates[0]!)).rowCount).toBe(1);

      const { rows: backend } = await loser.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const racing = claim(loser, candidates[1]!).then(
        (result) => result.rowCount,
        (error: { code?: string }) => error.code,
      );

      // Waiting on the winner's row lock, not merely slow.
      for (let attempt = 0; ; attempt++) {
        const { rows } = await admin.query<{ blocked: boolean }>(
          "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
          [backend[0]!.pid],
        );
        if (rows[0]?.blocked) break;
        if (attempt === 1500) throw new Error("the second completion never waited for the first");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await winner.query("commit");

      // Matched nothing rather than overwrote. The losing completion rolls
      // back and removes the object it promoted; the file is the winner's.
      expect(await racing).toBe(0);
      await loser.query("commit");
    } finally {
      for (const session of [winner, loser]) {
        await session.query("rollback").catch(() => undefined);
        session.release();
      }
    }

    const { rows: settled } = await admin.query<{ file_id: string | null }>(
      'select "file_id" from "file_upload" where "id" = $1',
      [uploadId],
    );
    expect(settled[0]?.file_id).toBe(candidates[0]);
  });

  it.each([
    ["amending", "PATCH"],
    ["discarding", "DELETE"],
  ])("says gone, not signed, when evidence is discarded while %s it", async (_case, method) => {
    // A locked read is governed by the UPDATE policy, so an empty result means
    // the row is attested — or that it was deleted while this transaction
    // waited for the lock. The two are indistinguishable from the lock alone,
    // and answering "already attested" for something discarded and never
    // signed is a confident wrong answer.
    const id = await control(`Discarded while ${method}`);
    const evidenceId = await evidenceFor(id, "About to be discarded");

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const attempt = request(`/evidence/${evidenceId}`, {
          method,
          ...(method === "PATCH" ? { body: JSON.stringify({ title: "Mine" }) } : {}),
        });
        await blocked();
        await session.query('delete from "evidence" where "id" = $1', [evidenceId]);
        await session.query("commit");
        return attempt;
      },
    );

    expect(response.status).toBe(404);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found");
  });

  it("holds the file limit when uploads arrive together", async () => {
    // The limit is counted by the handler, and nothing in the schema enforces
    // it — which used to mean two uploads racing could leave an evidence
    // carrying one file too many. The lock the attach now takes to exclude an
    // attestation also excludes another attach, so the count is decided once.
    // Asserted rather than assumed: this is the kind of claim that has been
    // wrong before (ADR 0013, ADR 0020).
    const id = await control("Filling up");
    const evidenceId = await evidenceFor(id, "At the limit");

    // Prepared and sent one at a time, so that what arrives together is the
    // completions — the step that counts the room and takes it.
    const uploads: string[] = [];
    for (let which = 0; which < maxFilesPerEvidence + 2; which += 1) {
      uploads.push(await uploaded(evidenceId, `file-${which}.txt`));
    }

    // Two past the limit, all at once.
    const attempts = await Promise.all(uploads.map(async (id) => completeUpload(request, id)));

    const accepted = attempts.filter((response) => response.status === 200).length;
    const refused = attempts.filter((response) => response.status === 409).length;
    expect(accepted).toBe(maxFilesPerEvidence);
    expect(refused).toBe(2);

    const { rows } = await admin.query<{ count: number }>(
      'select count(*)::int as count from "file" where "evidence_id" = $1',
      [evidenceId],
    );
    expect(rows[0]?.count).toBe(maxFilesPerEvidence);
  }, 60_000);

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

  it.each([
    ["attested", 409, "already_attested"],
    ["discarded", 404, "not_found"],
  ])(
    "answers %s rather than stale when evidence is %s while an attestation waits",
    async (what, status, code) => {
      // Attesting waits on the UPDATE lock and checks the version there.
      // Matching nothing has three causes; only an amendment is "stale".
      const id = await control(`Attestation meets ${what}`);
      const evidenceId = await evidenceFor(id, `To be ${what} first`);
      const read = await tagOf(`/evidence/${evidenceId}`);

      const response = await holding(
        `select * from "evidence" where "id" = $1 for update`,
        [evidenceId],
        async ({ session, blocked }) => {
          const attesting = request(`/evidence/${evidenceId}/attestation`, {
            method: "PUT",
            headers: { "if-match": read },
          });
          await blocked();
          await session.query(
            what === "attested"
              ? `update "evidence" set "attested_at" = now(), "attested_by_id" = 'usr_0000000000000000',
                 "attested_by_label" = 'Someone else' where "id" = $1`
              : `delete from "evidence" where "id" = $1`,
            [evidenceId],
          );
          await session.query("commit");
          return attesting;
        },
      );

      expect(response.status).toBe(status);
      expect((await json<{ error: { code: string } }>(response)).error.code).toBe(code);
    },
  );

  it.each([
    ["amending", "PATCH"],
    ["discarding", "DELETE"],
  ])("says signed, not gone, when evidence is attested while %s it", async (_case, method) => {
    // The other half of what an empty locked read can mean: attested rows are
    // invisible to the UPDATE policy that governs the lock, so the re-read is
    // what tells this from a discard.
    const id = await control(`Attested while ${method}`);
    const evidenceId = await evidenceFor(id, "About to be signed");

    const response = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const attempt = request(`/evidence/${evidenceId}`, {
          method,
          ...(method === "PATCH" ? { body: JSON.stringify({ title: "Mine" }) } : {}),
        });
        await blocked();
        await session.query(
          `update "evidence" set "attested_at" = now(), "attested_by_id" = 'usr_0000000000000000',
           "attested_by_label" = 'Someone else' where "id" = $1`,
          [evidenceId],
        );
        await session.query("commit");
        return attempt;
      },
    );

    expect(response.status).toBe(409);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("already_attested");
  });

  it("lets two evidence amendments through in turn, and records what each replaced", async () => {
    // Serialised rather than refused: neither names a version, so neither is
    // asking to be protected. What must not happen is an audit event claiming
    // to have replaced something it did not — the second amendment's `before`
    // has to be what the first wrote, not what it read before the first ran.
    //
    // `Promise.all` alone would not force that: it starts both requests, it
    // does not make their reads overlap. Both have to be waiting on the same
    // lock before either is let go.
    const id = await control("Amended twice");
    const evidenceId = await evidenceFor(id, "Original");

    const [first, second] = await holding(
      `select * from "evidence" where "id" = $1 for update`,
      [evidenceId],
      async ({ session, blocked }) => {
        const both = Promise.all([
          request(`/evidence/${evidenceId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: "One" }),
          }),
          request(`/evidence/${evidenceId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: "Two" }),
          }),
        ]);
        await blocked(2);
        await session.query("commit");
        return both;
      },
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    const { data } = await json<{ data: { action: string; before: { title?: string } | null }[] }>(
      await request(`/history?resource=${evidenceId}`),
    );
    const replaced = data
      .filter((event) => event.action === "updated")
      .map((event) => event.before?.title);

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

describe.skipIf(!usable)("holding a connection while doing something slow", () => {
  /**
   * The same store, but every request to it takes its time.
   *
   * Talking to object storage is the slowest thing a completion does — a
   * `HEAD`, a copy, and a read of up to 25 MiB to measure. If a connection were
   * held across any of it, a deployment would run out of connections under a
   * handful of concurrent uploads, and nothing would fail until it did, which
   * is the worst way to find out.
   */
  const unhurried = (slow: number): ObjectStore =>
    objectStoreInS3({
      ...storage.configuration,
      fetch: async (asked) => {
        await new Promise((resolve) => setTimeout(resolve, slow));
        return storage.configuration.fetch!(asked);
      },
    });

  it("completes more uploads at once than there are connections", async () => {
    // Two connections, eight completions, each spending longer talking to the
    // store than a connection may be waited for. What it proves is that the
    // storage phase as a whole is not held across a connection: wrap the phase
    // in a transaction and completions start failing to get one at all. It is
    // wall-clock, so it is not a proof about any single call — a hard "no
    // object I/O while a connection is checked out" would want instrumentation
    // rather than a tighter threshold.
    //
    // Which ones fail depends on scheduling, so the assertion is that none
    // does. Each completion makes four store requests — head, copy, read,
    // discard — so at 500ms apiece that is two seconds of work per completion
    // and eight seconds on two connections, against a wait of 1800ms.
    const cramped = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 1800,
      options: `-c role=${runtime}`,
    });
    try {
      const constrained = createApp({
        db: createDatabase(cramped),
        store: unhurried(500),
        auth: createAuth(createDatabase(cramped), {
          baseURL: "http://localhost",
          secret: "test-secret-of-at-least-32-characters",
        }),
      });

      const id = await control("Uploaded to at length");
      const evidenceId = await evidenceFor(id, "Eight files at once");

      // Prepared and sent through the unhurried app's faster twin, so that
      // what is slow is only the step under test.
      const uploads: string[] = [];
      for (let which = 0; which < 8; which += 1) {
        uploads.push(await uploaded(evidenceId, `slow-${which}.txt`));
      }

      const completions = await Promise.all(
        uploads.map(async (uploadId) =>
          constrained.request(
            `/api/v1/organizations/${acme.organizationId}/file-uploads/${uploadId}/completion`,
            { method: "PUT", headers: { cookie: acme.cookie } },
          ),
        ),
      );

      // A refusal carries its body, so a failure here names the error — a pool
      // timeout, or something else — rather than only that there was one.
      const outcomes = await Promise.all(
        completions.map(async (response) =>
          response.status === 200 ? 200 : `${response.status} ${await response.text()}`,
        ),
      );
      expect(outcomes).toEqual(Array(8).fill(200));
    } finally {
      await cramped.end();
    }
  }, 60_000);
});
