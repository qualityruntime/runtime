// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The collection contract: how `/api/v1` collections page, over HTTP.
 *
 * Exercised on both collections that have one — controls, and the history of a
 * control — because the point of settling it once is that they behave the same.
 * Requests run as a non-superuser role that owns the tables, with row-level
 * security forced so the policies bind their owner.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema, withOrganization } from "@qualityruntime/db";
import { sql } from "drizzle-orm";
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
let acme: { cookie: string; organizationId: string };

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Page<T> = { data: T[]; nextCursor: string | null };
type Named = { id: string; name: string };
type Failure = { error: { code: string; details?: { path: string }[] } };

const NUL = String.fromCharCode(0);
const encoded = (value: string) =>
  encodeURIComponent(Buffer.from(value, "utf8").toString("base64url"));

/** A request to this organization, at `path` under it. */
const organization = async (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Response> =>
  app.request(`/api/v1/organizations/${acme.organizationId}${path}`, {
    ...init,
    // Merged, not replaced: a caller's own headers are the point of
    // passing them, and dropping them silently makes a test pass for
    // the wrong reason.
    headers: {
      cookie: acme.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

const request = async (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
): Promise<Response> =>
  app.request(`/api/v1/organizations/${acme.organizationId}/controls${path}`, {
    ...init,
    // Merged, not replaced: a caller's own headers are the point of
    // passing them, and dropping them silently makes a test pass for
    // the wrong reason.
    headers: {
      cookie: acme.cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

async function create(name: string): Promise<Named> {
  const response = await request("", { method: "POST", body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  return (await json<{ data: Named }>(response)).data;
}

/** Walks every page from `from`, returning what a client would have collected. */
async function walkUsing<T>(
  fetch: (query: string) => Promise<Response>,
  query: string,
  from: string | null = null,
): Promise<T[]> {
  const collected: T[] = [];
  let cursor: string | null = from;
  for (let guard = 0; guard < 20; guard++) {
    const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${query}${suffix}`);
    expect(response.status).toBe(200);
    const body: Page<T> = await json<Page<T>>(response);
    collected.push(...body.data);
    if (!body.nextCursor) return collected;
    cursor = body.nextCursor;
  }
  throw new Error("paging did not terminate");
}

const walk = <T>(path: string, query: string, from: string | null = null) =>
  walkUsing<T>((full) => request(`${path}?${full}`), query, from);

/** `walk`, for a collection under the organization rather than under controls. */
const walkOrganization = <T>(path: string, query: string, from: string | null = null) =>
  walkUsing<T>(
    (full) => organization(`${path}${path.includes("?") ? "&" : "?"}${full}`),
    query,
    from,
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

  const signedUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: "acme@example.test", password: "correct horse" }),
  });
  expect(signedUp.status).toBe(200);
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const created = await app.request("/api/auth/organization/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Acme", slug: "acme" }),
  });
  expect(created.status).toBe(200);
  acme = { cookie, organizationId: (await json<{ id: string }>(created)).id };

  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);
}, 60_000);

describe("paging a collection", () => {
  it("returns every row exactly once, newest first", async () => {
    const names = ["one", "two", "three", "four", "five"];
    for (const name of names) await create(name);

    const walked = await walk<Named>("", "limit=2");

    // Every control this organization has, in one order, with no repeats.
    expect(walked.map((row) => row.name)).toEqual([...names].reverse());
  });

  it("ends without a cursor rather than on an empty page", async () => {
    const { nextCursor, data } = await json<Page<Named>>(await request("?limit=100"));

    expect(data.length).toBeGreaterThan(0);
    expect(nextCursor).toBeNull();
  });

  it("offers a cursor when there is more, and honours it", async () => {
    const first = await json<Page<Named>>(await request("?limit=2"));
    expect(first.nextCursor).not.toBeNull();

    const second = await json<Page<Named>>(
      await request(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`),
    );

    const ids = new Set(first.data.map((row) => row.id));
    expect(second.data.some((row) => ids.has(row.id))).toBe(false);
  });

  it("refuses a non-canonical encoding of a genuine cursor", async () => {
    const { nextCursor } = await json<Page<Named>>(await request("?limit=2"));

    const response = await request(`?limit=2&cursor=${encodeURIComponent(`${nextCursor!}!!`)}`);

    expect(response.status).toBe(400);
  });

  it("does not skip or repeat a row when the collection grows mid-walk", async () => {
    // The reason this is a cursor and not an offset. Newer rows sort ahead of
    // the page already read, so an offset would shift everything down and repeat
    // one; a cursor names a position and is unaffected.
    const before = await json<Page<Named>>(await request("?limit=100"));
    const first = await json<Page<Named>>(await request("?limit=2"));

    await create("inserted mid-walk");

    const rest = await walk<Named>("", "limit=2", first.nextCursor);
    const seen = [...first.data, ...rest].map((row) => row.id);

    expect(new Set(seen).size).toBe(seen.length);
    // Everything that existed when the walk began is still accounted for.
    expect(seen).toEqual(expect.arrayContaining(before.data.map((row) => row.id)));
  });
});

describe("the collection query", () => {
  it("does not lose rows whose timestamps differ only in microseconds", async () => {
    // PostgreSQL keeps a timestamptz to the microsecond; a JavaScript Date only
    // to the millisecond. A cursor built from a Date would resume up to 999µs
    // early — or, here, name .123000 for a row at .123900 and skip the two
    // between. Written with explicit timestamps because a clock cannot be
    // relied on to produce the collision on demand.
    const control = await create("microseconds");
    const at = ["123100", "123500", "123900"];
    await withOrganization(db, acme.organizationId, async (tx) => {
      for (const [index, micros] of at.entries()) {
        await tx.execute(
          sql`insert into "audit_event"
                ("id", "organization_id", "actor_type", "actor_id", "action",
                 "resource_type", "resource_id", "after", "created_at")
              values (${`aud_000000000000000${index}`}, ${acme.organizationId}, 'system', null,
                      'updated', 'control', ${control.id}, '{}'::jsonb,
                      ${`2030-01-01T00:00:00.${micros}Z`}::timestamptz)`,
        );
      }
    });

    const walked = await walkOrganization<{ id: string }>(
      `/history?resource=${control.id}`,
      "limit=1",
    );

    // All three, plus the creation the control already had.
    expect(walked).toHaveLength(at.length + 1);
    expect(new Set(walked.map((event) => event.id)).size).toBe(walked.length);
  });

  it("issues cursors in the three-part form these fixtures use", async () => {
    // Guards the fixtures below: were the wire format to change, they would go
    // on passing on a malformed envelope without reaching what they test.
    const { nextCursor } = await json<Page<Named>>(await request("?limit=1"));
    const decoded = Buffer.from(nextCursor!, "base64url").toString("utf8");

    expect(decoded.split("|")).toHaveLength(3);
    expect(decoded.startsWith("controls:recent|")).toBe(true);
  });

  it.each([
    ["a limit of zero", "limit=0"],
    ["a limit beyond the maximum", "limit=101"],
    ["a limit that is not a number", "limit=lots"],
    ["a cursor this API did not issue", "cursor=not-a-cursor"],
    // Each of these decodes, and each would reach PostgreSQL as a 500 if the
    // decoded halves were not checked against what this API actually issues.
    [
      "a cursor whose id carries a NUL",
      `cursor=${encoded(`controls:recent|2026-01-01T00:00:00.000000Z|ctl_a${NUL}b`)}`,
    ],
    [
      "a cursor with a year PostgreSQL cannot hold",
      `cursor=${encoded("controls:recent|-010000-01-01T00:00:00.000000Z|ctl_v1stgxr8z5jdhi6b")}`,
    ],
    [
      "a cursor with a millisecond timestamp",
      `cursor=${encoded("controls:recent|2026-01-01T00:00:00.000Z|ctl_v1stgxr8z5jdhi6b")}`,
    ],
    [
      "a cursor with extra parts",
      `cursor=${encoded("controls:recent|2026-01-01T00:00:00.000000Z|ctl_v1stgxr8z5jdhi6b|more")}`,
    ],
    // Well-formed to look at, and rejected by the cast: the shape of a
    // timestamp says nothing about whether the instant exists.
    [
      "a cursor dated the thirtieth of February",
      `cursor=${encoded("controls:recent|2026-02-30T00:00:00.000000Z|ctl_v1stgxr8z5jdhi6b")}`,
    ],
    [
      "a cursor with a twenty-fifth hour",
      `cursor=${encoded("controls:recent|2026-01-01T25:00:00.000000Z|ctl_v1stgxr8z5jdhi6b")}`,
    ],
    [
      "a cursor in year zero, which PostgreSQL has not got",
      `cursor=${encoded("controls:recent|0000-01-01T00:00:00.000000Z|ctl_v1stgxr8z5jdhi6b")}`,
    ],
  ])("refuses %s", async (_case, query) => {
    const response = await request(`?${query}`);

    expect(response.status).toBe(400);
    const { error } = await json<Failure>(response);
    expect(error.code).toBe("invalid_request");
    expect(error.details?.map((detail) => detail.path)).toContain(query.split("=")[0]);
    expect(response.status).not.toBe(500);
  });

  it("uses a default limit when none is given", async () => {
    const { data } = await json<Page<Named>>(await request(""));

    expect(data.length).toBeLessThanOrEqual(25);
  });
});

describe("the history of a record", () => {
  it("pages the same way, newest first", async () => {
    const control = await create("history");
    for (const name of ["first rename", "second rename", "third rename"]) {
      expect(
        (await request(`/${control.id}`, { method: "PATCH", body: JSON.stringify({ name }) }))
          .status,
      ).toBe(200);
    }

    const walked = await walkOrganization<{ action: string; after: Record<string, unknown> }>(
      `/history?resource=${control.id}`,
      "limit=2",
    );

    expect(walked.map((event) => event.action)).toEqual([
      "updated",
      "updated",
      "updated",
      "created",
    ]);
    expect(walked.at(-1)?.after).toEqual({ name: "history", description: null, status: "draft" });
  });

  it("describes an event without repeating what the URL already said", async () => {
    const control = await create("shaped");

    const { data } = await json<Page<Record<string, unknown>>>(
      await organization(`/history?resource=${control.id}`),
    );

    // The contract, written out rather than the row: no organization — the URL
    // named it — and the actor's columns grouped. The resource *is* named,
    // because this collection spans records and the URL no longer says which.
    expect(Object.keys(data[0]!).sort()).toEqual([
      "action",
      "actor",
      "after",
      "before",
      "createdAt",
      "id",
      "resourceId",
      "resourceType",
    ]);
    expect(data[0]!.actor).toEqual({
      type: "user",
      id: expect.stringMatching(/^usr_/) as string,
      label: "Ada",
      onBehalfOf: null,
    });
  });

  it("answers with an empty page for a record that is not there", async () => {
    // History outlives what it describes, so there is nothing to look the
    // record up in: a control that never existed and one in another
    // organization are both simply an organization's history that says
    // nothing about them (ADR 0018).
    const response = await organization("/history?resource=ctl_0000000000000000");

    expect(response.status).toBe(200);
    expect((await json<Page<unknown>>(response)).data).toEqual([]);
  });

  it("refuses an identifier that names no kind of record", async () => {
    const response = await organization("/history?resource=nonsense");

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });
});
