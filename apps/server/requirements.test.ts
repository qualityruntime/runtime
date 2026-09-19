// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a requirement on its own, the controls that answer to it, which
 * clauses of a standard nobody has taken up, and finding a clause by the
 * reference people cite.
 *
 * The last is the first question this API answers rather than records, so most
 * of what is checked here is that the filter says what it means. Requests run
 * as a non-superuser role that owns the tables, so the row-level security
 * policies are in force as they are in a deployment.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema } from "@qualityruntime/db";
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

let app: ReturnType<typeof createApp>;
type Tenant = { cookie: string; organizationId: string };
let acme: Tenant;
let globex: Tenant;

let standardId: string;
/** Acme's five requirements, in the order their standard states them. */
let requirements: { id: string; reference: string }[];
let theirRequirement: string;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

type Page<T> = { data: T[]; nextCursor: string | null };
type Named = { id: string; name: string };
type Failure = { error: { code: string; details?: { path: string }[] } };

const request = (
  tenant: Tenant,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  app.request(`/api/v1/organizations/${tenant.organizationId}${path}`, {
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

async function newControl(tenant: Tenant, name: string): Promise<string> {
  const response = await request(tenant, "/controls", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data.id;
}

const answerTo = (tenant: Tenant, controlId: string, requirementIds: string[]) =>
  request(tenant, `/controls/${controlId}/requirements`, {
    method: "PUT",
    body: JSON.stringify({ requirementIds }),
  });

const listRequirements = async (tenant: Tenant, id: string, query = "") =>
  json<Page<{ id: string; reference: string }>>(
    await request(tenant, `/standards/${id}/requirements${query}`),
  );

beforeAll(async () => {
  const client = new PGlite();
  const db = createTestDatabase(client);
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

  await client.exec(`
    create role qualityruntime_app nosuperuser nobypassrls;
    grant all on all tables in schema public to qualityruntime_app;
    alter table "control" owner to qualityruntime_app;
    alter table "audit_event" owner to qualityruntime_app;
    alter table "standard" owner to qualityruntime_app;
    alter table "requirement" owner to qualityruntime_app;
    alter table "control_requirement" owner to qualityruntime_app;
    set role qualityruntime_app;
  `);

  const importStandard = async (owner: Tenant, count: number) => {
    const response = await request(owner, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 9001",
        edition: "2015",
        requirements: Array.from({ length: count }, (_, index) => ({
          reference: `7.${index + 1}`,
          title: `Clause ${index + 1}`,
        })),
      }),
    });
    expect(response.status).toBe(201);
    const id = (await json<{ data: { id: string } }>(response)).data.id;
    return { id, requirements: (await listRequirements(owner, id, "?limit=100")).data };
  };

  const acmeStandard = await importStandard(acme, 5);
  standardId = acmeStandard.id;
  requirements = acmeStandard.requirements;
  theirRequirement = (await importStandard(globex, 1)).requirements[0]!.id;

  // 7.1 is answered by two controls, 7.2 by one, and 7.3 to 7.5 by none.
  const first = await newControl(acme, "Access review");
  const second = await newControl(acme, "Backup restore test");
  await answerTo(acme, first, [requirements[0]!.id, requirements[1]!.id]);
  await answerTo(acme, second, [requirements[0]!.id]);
}, 60_000);

describe("a requirement on its own", () => {
  it("is reachable without naming its standard", async () => {
    const response = await request(acme, `/requirements/${requirements[0]!.id}`);

    expect(response.status).toBe(200);
    const { data } = await json<{ data: { reference: string; standardId: string } }>(response);
    expect(data.reference).toBe("7.1");
    expect(data.standardId).toBe(standardId);
  });

  it.each([
    ["one that does not exist", "req_0000000000000000"],
    ["an id of the wrong shape", "not-an-id"],
    ["an id carrying another table's prefix", "ctl_v1stgxr8z5jdhi6b"],
  ])("answers 404 for %s", async (_case, id) => {
    const response = await request(acme, `/requirements/${id}`);

    expect(response.status).toBe(404);
    expect((await json<Failure>(response)).error.code).toBe("not_found");
  });

  it("answers 404 for another organization's requirement", async () => {
    const theirs = await request(acme, `/requirements/${theirRequirement}`);
    const absent = await request(acme, "/requirements/req_0000000000000000");

    expect(theirs.status).toBe(404);
    expect(await json(theirs)).toEqual(await json(absent));
  });
});

describe("the controls that answer to a requirement", () => {
  it("lists them, newest first", async () => {
    const response = await request(acme, `/requirements/${requirements[0]!.id}/controls`);

    expect(response.status).toBe(200);
    const { data } = await json<Page<Named>>(response);
    expect(data.map((row) => row.name)).toEqual(["Backup restore test", "Access review"]);
  });

  it("is empty for a requirement nothing answers to", async () => {
    const { data } = await json<Page<Named>>(
      await request(acme, `/requirements/${requirements[4]!.id}/controls`),
    );

    expect(data).toEqual([]);
  });

  it("pages like every other collection", async () => {
    const first = await json<Page<Named>>(
      await request(acme, `/requirements/${requirements[0]!.id}/controls?limit=1`),
    );
    expect(first.nextCursor).not.toBeNull();

    const second = await json<Page<Named>>(
      await request(
        acme,
        `/requirements/${requirements[0]!.id}/controls?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
    );

    expect(second.data.map((row) => row.name)).toEqual(["Access review"]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a cursor from another requirement's controls", async () => {
    const theirs = await json<Page<Named>>(
      await request(acme, `/requirements/${requirements[0]!.id}/controls?limit=1`),
    );

    const response = await request(
      acme,
      `/requirements/${requirements[1]!.id}/controls?cursor=${encodeURIComponent(theirs.nextCursor!)}`,
    );

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("cursor");
  });

  it("answers 404 for another organization's requirement", async () => {
    expect((await request(acme, `/requirements/${theirRequirement}/controls`)).status).toBe(404);
  });
});

describe("which clauses nobody has taken up", () => {
  it("keeps only the requirements with no control mapped", async () => {
    const { data } = await listRequirements(acme, standardId, "?mapped=false&limit=100");

    expect(data.map((row) => row.reference)).toEqual(["7.3", "7.4", "7.5"]);
  });

  it("keeps only the requirements that have one", async () => {
    const { data } = await listRequirements(acme, standardId, "?mapped=true&limit=100");

    expect(data.map((row) => row.reference)).toEqual(["7.1", "7.2"]);
  });

  it("returns everything when the filter is left out", async () => {
    const { data } = await listRequirements(acme, standardId, "?limit=100");

    expect(data).toHaveLength(5);
  });

  it("follows a clause as it is taken up and let go", async () => {
    const control = await newControl(acme, "Temporary");
    const unmapped = () =>
      listRequirements(acme, standardId, "?mapped=false&limit=100").then(({ data }) =>
        data.map((row) => row.reference),
      );

    await answerTo(acme, control, [requirements[2]!.id]);
    expect(await unmapped()).toEqual(["7.4", "7.5"]);

    await answerTo(acme, control, []);
    expect(await unmapped()).toEqual(["7.3", "7.4", "7.5"]);
  });

  it("pages the filtered collection without losing the filter", async () => {
    const first = await listRequirements(acme, standardId, "?mapped=false&limit=2");
    expect(first.nextCursor).not.toBeNull();

    const second = await listRequirements(
      acme,
      standardId,
      `?mapped=false&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );

    expect(first.data.map((row) => row.reference)).toEqual(["7.3", "7.4"]);
    expect(second.data.map((row) => row.reference)).toEqual(["7.5"]);
  });

  it.each([
    ["neither true nor false", "?mapped=perhaps"],
    ["an empty value", "?mapped="],
  ])("refuses %s", async (_case, query) => {
    const response = await request(acme, `/standards/${standardId}/requirements${query}`);

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain("mapped");
  });
});

describe("a filter that is misspelt", () => {
  it.each([
    ["mapped", "?maped=false"],
    ["reference", "?refernece=7.3"],
  ])("refuses it rather than answering unfiltered (%s)", async (_case, query) => {
    const response = await request(acme, `/standards/${standardId}/requirements${query}`);

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.code).toBe("invalid_request");
  });
});

describe("a clause looked up by the reference people cite", () => {
  it("resolves a reference to the requirement it names", async () => {
    const { data, nextCursor } = await listRequirements(acme, standardId, "?reference=7.3");

    expect(data.map((row) => row.id)).toEqual([requirements[2]!.id]);
    expect(nextCursor).toBeNull();
  });

  it("finds nothing for a reference the standard does not state", async () => {
    const { data, nextCursor } = await listRequirements(acme, standardId, "?reference=7.30");

    expect(data).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it("matches exactly: not a prefix, not a pattern", async () => {
    for (const query of ["?reference=7", "?reference=7.%25", "?reference=7._"]) {
      expect((await listRequirements(acme, standardId, query)).data).toEqual([]);
    }
  });

  it("removes surrounding whitespace, as the import did", async () => {
    const { data } = await listRequirements(acme, standardId, "?reference=%207.3%20");

    expect(data.map((row) => row.reference)).toEqual(["7.3"]);
  });

  it("keeps case, because the reference is its exact string", async () => {
    const response = await request(acme, "/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ETSI EN 303 645",
        edition: "V3.1.3",
        requirements: [
          { reference: "Provision 5.1-1", title: "Unique passwords" },
          { reference: "provision 5.1-1", title: "The same clause, typed differently" },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const etsi = (await json<{ data: { id: string } }>(response)).data.id;

    const { data } = await listRequirements(acme, etsi, "?reference=Provision%205.1-1");

    expect(data.map((row) => row.reference)).toEqual(["Provision 5.1-1"]);
  });

  it("looks only in the standard named, and only in this organization", async () => {
    // Globex states 7.1 too, in its own copy of the same standard.
    const { data } = await listRequirements(acme, standardId, "?reference=7.1");

    expect(data.map((row) => row.id)).toEqual([requirements[0]!.id]);
  });

  it("composes with the mapped filter", async () => {
    const mapped = await listRequirements(acme, standardId, "?reference=7.1&mapped=true");
    const unmapped = await listRequirements(acme, standardId, "?reference=7.1&mapped=false");

    expect(mapped.data.map((row) => row.reference)).toEqual(["7.1"]);
    expect(unmapped.data).toEqual([]);
  });

  it.each([
    ["an empty value", "?reference="],
    ["only whitespace", "?reference=%20%20"],
    ["a NUL", "?reference=7%00"],
    ["more than a reference can hold", `?reference=${"7".repeat(101)}`],
  ])("refuses %s", async (_case, query) => {
    const response = await request(acme, `/standards/${standardId}/requirements${query}`);

    expect(response.status).toBe(400);
    expect((await json<Failure>(response)).error.details?.map((d) => d.path)).toContain(
      "reference",
    );
  });

  it("answers 404 for another organization's standard, not an empty page", async () => {
    const theirs = await request(globex, `/requirements/${theirRequirement}`);
    const { standardId: theirStandard } = (await json<{ data: { standardId: string } }>(theirs))
      .data;

    const response = await request(acme, `/standards/${theirStandard}/requirements?reference=7.1`);

    expect(response.status).toBe(404);
  });
});
