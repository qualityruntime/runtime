// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The OpenAPI description of `/api/v1`.
 *
 * Reuses request schemas and documented response schemas. Custom validation
 * and domain rules may impose constraints beyond JSON Schema; response
 * conformance is checked by tests, not by runtime serialization.
 * Reasoning — including why this is assembled here rather than by a library —
 * is in `docs/adr/0007-openapi-from-the-schemas.md`.
 */

import { auditEventResponse, historyQuery } from "./history.ts";
import { idPattern, type IdType } from "@qualityruntime/db";
import { z } from "zod";
import { controlOrder, controlResponse, createBody, updateBody } from "./controls.ts";
import { collectionQuery } from "./pagination.ts";
import { collection, failureResponse, single } from "./responses.ts";

/** OpenAPI 3.1 is JSON Schema draft 2020-12, which is what Zod emits. */
const jsonSchema = (schema: z.ZodType, io: "input" | "output") => {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io, target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  void $schema;
  return rest;
};

const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: jsonSchema(schema, "input") } },
});

const responds = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema: jsonSchema(schema, "output") } },
});

const fails = (description: string) => responds(description, failureResponse);

/**
 * A response carrying the record's version, which a conditional write quotes.
 *
 * Declared where one is actually served: a document that asks for `If-Match`
 * and never says where the tag comes from describes half a contract (ADR 0019).
 */
const versioned = (description: string, schema: z.ZodType) => ({
  ...responds(description, schema),
  headers: {
    ETag: {
      description: "The record's version. Quote it back in `If-Match` to change only this.",
      schema: { type: "string" },
    },
  },
});

/**
 * Query parameters, one per property of the schema.
 *
 * OpenAPI describes a query as a list of parameters rather than an object, so
 * the object is taken apart here; `io: "input"` is what makes a cursor appear
 * as the string a client actually sends rather than the position it decodes to.
 */
function queryParameters(schema: z.ZodObject) {
  const described = jsonSchema(schema, "input") as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return Object.entries(described.properties ?? {}).map(([name, property]) => ({
    name,
    in: "query",
    required: described.required?.includes(name) ?? false,
    schema: property,
  }));
}

/** Which kind of identifier each path parameter holds, for its pattern. */
const pathParameterTypes: Record<string, IdType> = {
  organizationId: "organization",
  controlId: "control",
};

/** Derived from the path itself, so a parameter cannot be left undescribed. */
function pathParameters(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => {
    const type = pathParameterTypes[name!];
    if (!type) throw new Error(`No identifier type is declared for the "${name}" path parameter.`);
    return {
      name,
      in: "path",
      required: true,
      schema: { type: "string", pattern: idPattern(type) },
    };
  });
}

/** `If-Match` where it is optional: supplied, the write is conditional on it (ADR 0019). */
const conditional = {
  name: "If-Match",
  in: "header",
  required: false,
  description:
    "The ETag of the record as it was read. Supplied, the write is refused with 412 if the " +
    "record has changed since; `*` means only if it still exists.",
  schema: { type: "string" },
};

type Operation = {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  query?: z.ZodObject;
  request?: z.ZodType;
  /** Headers an operation takes, which no schema here describes. */
  parameters?: unknown[];
  responses: Record<string, { description: string; content?: unknown }>;
};

const tenant = "/api/v1/organizations/{organizationId}";
const controls = `${tenant}/controls`;

/**
 * Every operation `/api/v1` serves.
 *
 * `openapi.test.ts` checks this against the routes the app actually registers,
 * so an operation cannot be added to one and forgotten in the other.
 */
const operations: Operation[] = [
  {
    method: "get",
    path: controls,
    summary: "List the organization's controls, newest first.",
    query: collectionQuery(controlOrder),
    responses: {
      "200": responds("A page of controls.", collection(controlResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such organization, or the caller is not a member of it."),
    },
  },
  {
    method: "post",
    path: controls,
    summary: "Create a control. It always starts as a draft.",
    request: createBody,
    responses: {
      "201": responds("The control that was created.", single(controlResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such organization, or the caller is not a member of it."),
      "413": fails("The body is too large."),
    },
  },
  {
    method: "get",
    path: `${controls}/{controlId}`,
    summary: "Retrieve one control.",
    responses: {
      "200": versioned("The control.", single(controlResponse)),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
    },
  },
  {
    method: "patch",
    path: `${controls}/{controlId}`,
    summary: "Change a control. Status moves follow the lifecycle.",
    parameters: [conditional],
    request: updateBody,
    responses: {
      "200": versioned("The control as it now stands.", single(controlResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
      "409": fails("That status change is not one the lifecycle allows."),
      "413": fails("The body is too large."),
      "412": fails("The record changed since it was read."),
    },
  },
  {
    method: "delete",
    path: `${controls}/{controlId}`,
    summary: "Discard a control that was never in effect and carries no evidence.",
    parameters: [conditional],
    responses: {
      "204": { description: "The draft is gone." },
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
      "409": fails("The control has been in effect, or it carries evidence."),
      "412": fails("The record changed since it was read."),
    },
  },
  {
    method: "get",
    path: `${tenant}/history`,
    summary: "Audit history, newest first. Narrow it to one record with `resource`.",
    query: historyQuery(),
    responses: {
      "200": responds("A page of audit events.", collection(auditEventResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      // The organization, not the record. Asking about a record that is not
      // there is an empty page, because history outlives records — but the
      // organization is still resolved before the handler runs (ADR 0018).
      "404": fails("No such organization, or the caller is not a member of it."),
    },
  },
];

/**
 * The document.
 *
 * Schemas are inlined rather than collected into `components`: they come
 * straight from the Zod definitions, and hand-written `$ref`s would be a second
 * description of the same thing to keep in step. No `servers` either — a client
 * has the URL it fetched this from, and a guess here would be wrong behind any
 * proxy.
 */
export function openApiDocument(sessionCookie: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of operations) {
    const parameters = [
      ...pathParameters(operation.path),
      ...queryParameters(operation.query ?? z.object({})),
      ...(operation.parameters ?? []),
    ];
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = {
      summary: operation.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(operation.request ? { requestBody: body(operation.request) } : {}),
      responses: operation.responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Quality Runtime",
      version: "0",
      description:
        "The open-source runtime for quality and compliance. Every tenant-owned resource " +
        "lives under an organization, and a caller must be a member of it.",
    },
    components: {
      securitySchemes: {
        // Better Auth issues this on sign-in and renews it, and names it
        // differently under HTTPS — so the name is taken from the instance.
        // `/api/auth` is its own API and is not described here.
        session: { type: "apiKey", in: "cookie", name: sessionCookie },
      },
    },
    security: [{ session: [] }],
    paths,
  };
}

/** What the app mounts. Public: it describes the API, not anyone's data. */
export const openApiPath = "/api/v1/openapi.json";

/**
 * Where the document is rendered for a person to read.
 *
 * Beside the document rather than instead of it: a client reads the JSON, and
 * this is for whoever has to understand it first.
 */
export const referencePath = "/api/v1/reference";
