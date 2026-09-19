// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * That the OpenAPI document describes the API that is actually served.
 *
 * A document assembled by hand is only worth having if it cannot drift, so two
 * things are checked against reality rather than against themselves: every
 * route the app registers is described, and every response the tests provoke
 * parses against the schema the document publishes.
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { schema } from "@qualityruntime/db";
import Ajv2020 from "ajv/dist/2020.js";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { sessionCookieName } from "./auth.ts";
import { openApiDocument, openApiPath, referencePath } from "./openapi.ts";

/**
 * A JSON Schema validator, because the point is what a client sees.
 *
 * Checking a response against the Zod schema it was built from would only prove
 * the two agree with each other; this validates it against the schema the
 * document actually publishes, conversion included.
 */
const ajv = new Ajv2020({ strict: false, allErrors: true });

type Document = ReturnType<typeof openApiDocument>;

/** The schema the document promises for one operation and status. */
function publishedSchema(document: Document, method: string, path: string, status: number) {
  const operation = (document.paths[path] as Record<string, unknown> | undefined)?.[method] as
    | { responses: Record<string, { content?: Record<string, { schema: object }> }> }
    | undefined;
  const schema = operation?.responses[String(status)]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`The document promises nothing for ${method} ${path} ${status}.`);
  return schema;
}

/** Asserts a response is what the document said it would be. */
async function conformsToDocument(
  document: Document,
  method: string,
  path: string,
  response: Response,
) {
  const body = await response.json();
  const validate = ajv.compile(publishedSchema(document, method, path, response.status));
  if (!validate(body)) {
    expect(validate.errors).toEqual([]);
  }
  expect(validate(body)).toBe(true);
}

const migrationsFolder = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url));

const createTestDatabase = (client: PGlite) => drizzle({ client, schema, casing: "snake_case" });

let app: ReturnType<typeof createApp>;
let auth: ReturnType<typeof createAuth>;
let acme: { cookie: string; organizationId: string };

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function create(name: string): Promise<{ id: string }> {
  const response = await request("", { method: "POST", body: JSON.stringify({ name }) });
  expect(response.status).toBe(201);
  return (await json<{ data: { id: string } }>(response)).data;
}

const request = (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
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

beforeAll(async () => {
  const client = new PGlite();
  const db = createTestDatabase(client);
  await migrate(db, { migrationsFolder });
  auth = createAuth(db, {
    baseURL: "http://localhost",
    secret: "test-secret-of-at-least-32-characters",
  });
  app = createApp({
    db,
    auth,
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

describe("the document", () => {
  it("is served without a session, because it describes no one's data", async () => {
    const response = await app.request(openApiPath);

    expect(response.status).toBe(200);
    const document = await json<{ openapi: string; paths: Record<string, unknown> }>(response);
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it("renders itself for a person to read", async () => {
    const response = await app.request(referencePath);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    // Whatever it renders, it renders *this* document.
    expect(await response.text()).toContain(openApiPath);
  });

  it("describes every route the app serves under /api/v1", async () => {
    // Derived from the router, so a route added without an operation fails
    // here. Hono lists one entry per handler, including validators, so the
    // same method and path appear more than once.
    const served = new Set(
      app.routes
        .filter((route) => route.method !== "ALL" && route.path.startsWith("/api/v1"))
        .map(
          (route) => `${route.method.toLowerCase()} ${route.path.replaceAll(/:(\w+)/g, "{$1}")}`,
        ),
    );
    // Neither is an operation: one is the document, the other renders it.
    served.delete(`get ${openApiPath}`);
    served.delete(`get ${referencePath}`);

    const document = openApiDocument(sessionCookieName(auth));
    const described = new Set(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`),
      ),
    );

    expect([...served].sort()).toEqual([...described].sort());
  });

  it("gives every path parameter the pattern its identifiers actually have", () => {
    const document = openApiDocument(sessionCookieName(auth));
    const parameters = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .flatMap((operation) => (operation as { parameters?: unknown[] }).parameters ?? [])
      .filter((parameter) => (parameter as { in: string }).in === "path");

    expect(parameters.length).toBeGreaterThan(0);
    for (const parameter of parameters as { name: string; schema: { pattern: string } }[]) {
      expect(parameter.schema.pattern).toMatch(/^\^[a-z]+_\[0-9a-z\]\{\d+\}\$$/);
    }
  });

  it("documents a cursor as the string a client sends, not what it decodes to", () => {
    // The schema carries a transform; describing its output would tell clients
    // to send an object they cannot send.
    const document = openApiDocument(sessionCookieName(auth));
    const list = document.paths["/api/v1/organizations/{organizationId}/controls"]!.get as {
      parameters: { name: string; schema: { type: string } }[];
    };
    const cursor = list.parameters.find((parameter) => parameter.name === "cursor");

    expect(cursor?.schema.type).toBe("string");
  });

  it("documents looking a requirement up by the reference people cite", () => {
    const document = openApiDocument(sessionCookieName(auth));
    const list = document.paths[
      "/api/v1/organizations/{organizationId}/standards/{standardId}/requirements"
    ]!.get as { parameters: { name: string; required?: boolean; schema: { type: string } }[] };
    const reference = list.parameters.find((parameter) => parameter.name === "reference");

    expect(reference?.schema.type).toBe("string");
    expect(reference?.required).not.toBe(true);
  });
});

describe("the requests it promises to accept", () => {
  const controls = "/api/v1/organizations/{organizationId}/controls";
  const one = `${controls}/{controlId}`;
  const NUL = String.fromCharCode(0);

  /** The request schema the document publishes for an operation. */
  const publishedBody = (method: string, path: string) => {
    const operation = (
      openApiDocument(sessionCookieName(auth)).paths[path] as Record<string, unknown>
    )[method] as { requestBody: { content: Record<string, { schema: object }> } };
    return operation.requestBody.content["application/json"]!.schema;
  };

  it.each([
    ["a body with no name", "post", controls, {}],
    ["a name of only spaces", "post", controls, { name: "   " }],
    ["a name carrying a NUL", "post", controls, { name: `a${NUL}b` }],
    ["a name beyond the bound", "post", controls, { name: "x".repeat(201) }],
    ["a change that changes nothing", "patch", one, {}],
    ["a change naming only an unknown field", "patch", one, { unknown: 1 }],
    ["a status outside the lifecycle", "patch", one, { status: "approved" }],
  ])("publishes a schema that refuses %s", async (_case, method, path, body) => {
    // The server refuses each of these. A document that says otherwise sends
    // clients to build requests that cannot work.
    const validate = ajv.compile(publishedBody(method, path));

    expect(validate(body)).toBe(false);
  });

  it.each([
    ["an ordinary body", { name: "Access review", description: "Quarterly." }],
    // Bounds are checked before trimming, so this is inside them for both the
    // server and the schema; getting that the wrong way round would have the
    // document refuse a request the server accepts.
    ["a name with surrounding whitespace", { name: "  Padded  " }],
    ["a name at the length bound", { name: "x".repeat(200) }],
  ])("publishes a schema that accepts %s, as the server does", async (_case, body) => {
    const validate = ajv.compile(publishedBody("post", controls));

    expect(validate(body)).toBe(true);
    expect((await request("", { method: "POST", body: JSON.stringify(body) })).status).toBe(201);
  });

  it("agrees with the server about a name only short enough once trimmed", async () => {
    // 201 characters sent, 200 after trimming. Whether this is accepted is
    // exactly the question of whether bounds are checked before or after
    // trimming, and the document and the server have to give the same answer.
    const body = { name: ` ${"x".repeat(200)}` };
    const validate = ajv.compile(publishedBody("post", controls));

    expect(validate(body)).toBe(false);
    expect((await request("", { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
  });

  it.each([
    ["get", "/api/v1/organizations/{organizationId}/controls/{controlId}", "200"],
    ["patch", "/api/v1/organizations/{organizationId}/controls/{controlId}", "200"],
    ["get", "/api/v1/organizations/{organizationId}/evidence/{evidenceId}", "200"],
    ["patch", "/api/v1/organizations/{organizationId}/evidence/{evidenceId}", "200"],
    ["post", "/api/v1/organizations/{organizationId}/controls/{controlId}/evidence", "201"],
    ["get", "/api/v1/organizations/{organizationId}/controls/{controlId}/requirements", "200"],
    ["put", "/api/v1/organizations/{organizationId}/controls/{controlId}/requirements", "200"],
  ])("says that %s %s answers %s with an ETag", (method, path, status) => {
    // A document that asks for `If-Match` and never says where the tag comes
    // from describes half a contract (ADR 0019). Recording evidence answers
    // with one too, so that it can be attested without a second read.
    const operation = (
      openApiDocument(sessionCookieName(auth)).paths[path] as Record<string, unknown>
    )[method] as { responses: Record<string, { headers?: Record<string, unknown> }> };

    expect(operation.responses[status]?.headers).toHaveProperty("ETag");
  });

  it("publishes where a cursor comes from", () => {
    const list = openApiDocument(sessionCookieName(auth)).paths[controls]!.get as {
      parameters: { name: string; schema: { description?: string } }[];
    };
    const cursor = list.parameters.find((parameter) => parameter.name === "cursor");

    // Nothing in the schema can say which strings are cursors, so the document
    // has to say where a client gets one.
    expect(cursor?.schema.description).toMatch(/nextCursor/);
  });
});

describe("the responses it promises", () => {
  const controls = "/api/v1/organizations/{organizationId}/controls";
  const one = `${controls}/{controlId}`;

  let document: Document;
  beforeAll(() => {
    document = openApiDocument(sessionCookieName(auth));
  });

  it("describes a created control", async () => {
    const response = await request("", {
      method: "POST",
      body: JSON.stringify({ name: "Access review" }),
    });

    expect(response.status).toBe(201);
    await conformsToDocument(document, "post", controls, response);
  });

  it("describes a page of controls", async () => {
    const response = await request("?limit=1");

    expect(response.status).toBe(200);
    await conformsToDocument(document, "get", controls, response);
  });

  it("describes one control", async () => {
    const created = await create("Retrieved");

    const response = await request(`/${created.id}`);

    expect(response.status).toBe(200);
    await conformsToDocument(document, "get", one, response);
  });

  it("describes a control that was changed", async () => {
    const created = await create("Before");

    const response = await request(`/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "After" }),
    });

    expect(response.status).toBe(200);
    await conformsToDocument(document, "patch", one, response);
  });

  it("describes a control that took effect", async () => {
    // Every other case here leaves `activatedAt` null, which matches the
    // document's null branch whatever the non-null one says. Only a control
    // that has actually been activated checks the format it is served in.
    const created = await create("Activated");

    const response = await request(`/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });

    expect(response.status).toBe(200);
    await conformsToDocument(document, "patch", one, response);

    // Read back rather than cloned: the check above consumes the body.
    const { data } = await json<{ data: { activatedAt: string } }>(await request(`/${created.id}`));
    expect(data.activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("describes a page of audit events", async () => {
    const created = await create("With history");

    const response = await app.request(
      `/api/v1/organizations/${acme.organizationId}/history?resource=${created.id}`,
      { headers: { cookie: acme.cookie } },
    );

    expect(response.status).toBe(200);
    await conformsToDocument(
      document,
      "get",
      "/api/v1/organizations/{organizationId}/history",
      response,
    );
  });

  it("describes a refused status change", async () => {
    const created = await create("Refused");

    const response = await request(`/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "retired" }),
    });

    expect(response.status).toBe(409);
    await conformsToDocument(document, "patch", one, response);
  });

  it("describes a body that is too large", async () => {
    const response = await request("", {
      method: "POST",
      body: JSON.stringify({ name: "Fine", padding: "x".repeat(100_000) }),
    });

    expect(response.status).toBe(413);
    await conformsToDocument(document, "post", controls, response);
  });

  it("describes an unauthenticated request", async () => {
    const response = await app.request(`/api/v1/organizations/${acme.organizationId}/controls`);

    expect(response.status).toBe(401);
    await conformsToDocument(document, "get", controls, response);
  });

  it("describes a control that is not there", async () => {
    const response = await request("/ctl_0000000000000000");

    expect(response.status).toBe(404);
    await conformsToDocument(document, "get", one, response);
  });

  it("describes a body that is not valid", async () => {
    const response = await request("", { method: "POST", body: "{}" });

    expect(response.status).toBe(400);
    await conformsToDocument(document, "post", controls, response);
  });
});

describe("the responses it promises for standards and mappings", () => {
  const tenant = "/api/v1/organizations/{organizationId}";
  let document: Document;

  const at = (
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
  ) =>
    app.request(`/api/v1/organizations/${acme.organizationId}${path}`, {
      ...init,
      headers: {
        cookie: acme.cookie,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

  /** One of each shape: the standard, a requirement, and a mapped control. */
  let standardId: string;
  let requirementId: string;
  let controlId: string;

  beforeAll(async () => {
    document = openApiDocument(sessionCookieName(auth));
    const imported = await at("/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 9001",
        edition: "2015",
        requirements: [{ reference: "7.5.3", title: "Documented information" }],
      }),
    });
    standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const listed = await at(`/standards/${standardId}/requirements`);
    requirementId = (await json<{ data: { id: string }[] }>(listed)).data[0]!.id;
    controlId = (await create("Mapped")).id;
    const mapped = await at(`/controls/${controlId}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds: [requirementId] }),
    });
    expect(mapped.status).toBe(200);
  });

  it.each([
    ["get", "/standards", `${tenant}/standards`],
    ["get", "/standards/{standardId}", `${tenant}/standards/{standardId}`],
    [
      "get",
      "/standards/{standardId}/requirements",
      `${tenant}/standards/{standardId}/requirements`,
    ],
    ["get", "/requirements/{requirementId}", `${tenant}/requirements/{requirementId}`],
    [
      "get",
      "/requirements/{requirementId}/controls",
      `${tenant}/requirements/{requirementId}/controls`,
    ],
    ["get", "/controls/{controlId}/requirements", `${tenant}/controls/{controlId}/requirements`],
  ])("describes %s %s", async (method, path, documented) => {
    const response = await at(
      path
        .replace("{standardId}", standardId)
        .replace("{requirementId}", requirementId)
        .replace("{controlId}", controlId),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { data: unknown };
    // A collection must carry an item, or only the envelope is checked.
    if (Array.isArray(body.data)) expect(body.data.length).toBeGreaterThan(0);
    await conformsToDocument(document, method, documented, response);
  });

  it("describes an imported standard", async () => {
    const response = await at("/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "ISO 9001",
        edition: "2026",
        requirements: [{ reference: "7.5.3", title: "Documented information" }],
      }),
    });

    expect(response.status).toBe(201);
    await conformsToDocument(document, "post", `${tenant}/standards`, response);
  });

  it("tells a client that the mapping tag versions the whole set, not the page", () => {
    const list = document.paths[`${tenant}/controls/{controlId}/requirements`]!.get as {
      responses: { "200": { headers: { ETag: { description: string } } } };
    };

    expect(list.responses["200"].headers.ETag.description).toMatch(/every page/);

    const put = document.paths[`${tenant}/controls/{controlId}/requirements`]!.put as {
      parameters: { name: string; description: string }[];
    };
    const ifMatch = put.parameters.find((parameter) => parameter.name === "If-Match");
    expect(ifMatch?.description).toMatch(/every page/);
    expect(ifMatch?.description).toContain("`*`");
  });

  it("describes a replaced mapping", async () => {
    const response = await at(`/controls/${controlId}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds: [requirementId] }),
    });

    expect(response.status).toBe(200);
    await conformsToDocument(
      document,
      "put",
      `${tenant}/controls/{controlId}/requirements`,
      response,
    );
  });
});

describe("the responses it promises for evidence", () => {
  const tenant = "/api/v1/organizations/{organizationId}";
  const one = `${tenant}/evidence/{evidenceId}`;
  let document: Document;
  let controlId: string;
  let requirementId: string;

  const at = (
    path: string,
    init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
  ) =>
    app.request(`/api/v1/organizations/${acme.organizationId}${path}`, {
      ...init,
      headers: {
        cookie: acme.cookie,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

  /** Records evidence and answers its id and the tag it came back with. */
  const recorded = async (title: string) => {
    const response = await at(`/controls/${controlId}/evidence`, {
      method: "POST",
      body: JSON.stringify({ title, occurredAt: "2026-07-01T09:00:00.000Z" }),
    });
    expect(response.status).toBe(201);
    return {
      id: ((await response.clone().json()) as { data: { id: string } }).data.id,
      tag: response.headers.get("etag")!,
      response,
    };
  };

  beforeAll(async () => {
    document = openApiDocument(sessionCookieName(auth));
    controlId = (await create("Evidenced")).id;
    const imported = await at("/standards", {
      method: "POST",
      body: JSON.stringify({
        name: "Evidenced standard",
        edition: "1",
        requirements: [{ reference: "1", title: "One" }],
      }),
    });
    const standardId = (await json<{ data: { id: string } }>(imported)).data.id;
    const listed = await at(`/standards/${standardId}/requirements`);
    requirementId = (await json<{ data: { id: string }[] }>(listed)).data[0]!.id;
    await at(`/controls/${controlId}/requirements`, {
      method: "PUT",
      body: JSON.stringify({ requirementIds: [requirementId] }),
    });
  });

  it("describes recorded evidence", async () => {
    const { response } = await recorded("Recorded");

    await conformsToDocument(document, "post", `${tenant}/controls/{controlId}/evidence`, response);
  });

  it.each([
    ["one piece of evidence", "get", one],
    ["an amendment", "patch", one],
    ["an attestation", "put", `${one}/attestation`],
  ])("describes %s", async (_case, method, documented) => {
    const { id, tag } = await recorded(`For ${method}`);
    const init =
      method === "patch"
        ? { method: "PATCH", body: JSON.stringify({ title: "Amended" }) }
        : method === "put"
          ? { method: "PUT", headers: { "if-match": tag } }
          : {};

    const response = await at(documented.replace(tenant, "").replace("{evidenceId}", id), init);

    expect(response.status).toBe(200);
    await conformsToDocument(document, method, documented, response);
  });

  it.each([
    ["a control's evidence", `${tenant}/controls/{controlId}/evidence`],
    ["a requirement's evidence", `${tenant}/requirements/{requirementId}/evidence`],
  ])("describes a page of %s, with an item in it", async (_case, documented) => {
    await recorded("Listed");
    const response = await at(
      documented
        .replace(tenant, "")
        .replace("{controlId}", controlId)
        .replace("{requirementId}", requirementId),
    );

    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
    await conformsToDocument(document, "get", documented, response);
  });
});
