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
import {
  controlOrder,
  controlResponse,
  controlRequirementsBody,
  controlRequirementsOrder,
  controlRequirementsResponse,
  createBody,
  updateBody,
} from "./controls.ts";
import { collectionQuery } from "./pagination.ts";
import {
  evidenceAmendBody,
  evidenceBody,
  evidenceOrder,
  evidenceResponse,
  requirementEvidenceOrder,
} from "./evidence.ts";
import { fileResponse, fileUploadResponse, maxFileBytes, prepareUploadBody } from "./files.ts";
import { requirementControlsOrder, requirementResponse } from "./requirements.ts";
import {
  importBody,
  requirementOrder,
  requirementsQuery,
  standardOrder,
  standardResponse,
} from "./standards.ts";
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
const versioned = (
  description: string,
  schema: z.ZodType,
  tag = "The version of what was read. Quote it back in `If-Match` to change only that.",
) => ({
  ...responds(description, schema),
  headers: { ETag: { description: tag, schema: { type: "string" } } },
});

/**
 * A control's requirements are versioned as a whole set, not per page, and a
 * client assembling the set from pages has to know it (ADR 0010).
 */
const setTag =
  "The version of the whole set, not of this page. A client reading several pages to replace " +
  "the set needs the same tag on every page, and reads again from the first if one differs; " +
  "quote it in `If-Match` on the replacement.";

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
  standardId: "standard",
  requirementId: "requirement",
  evidenceId: "evidence",
  fileId: "file",
  uploadId: "fileUpload",
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

/**
 * `If-Match` where it is optional: supplied, the write is conditional on it.
 *
 * Attesting names its own, because there it is required (ADR 0019).
 */
const conditional = {
  name: "If-Match",
  in: "header",
  required: false,
  description:
    "The ETag of what was read. Supplied, the write is refused with 412 if it has " +
    "changed since; `*` means only if it still exists.",
  schema: { type: "string" },
};

type Operation = {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  summary: string;
  /** More than a summary, where the operation is part of a sequence. */
  description?: string;
  query?: z.ZodObject;
  request?: z.ZodType;
  /** Additional request parameters, including optional and required headers. */
  parameters?: unknown[];
  responses: Record<
    string,
    { description: string; content?: unknown; headers?: Record<string, unknown> }
  >;
};

const tenant = "/api/v1/organizations/{organizationId}";
const controls = `${tenant}/controls`;
const standards = `${tenant}/standards`;

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
    path: `${controls}/{controlId}/requirements`,
    summary: "List the requirements a control answers to.",
    // Any control: the published schema is the same whichever it is.
    query: collectionQuery(controlRequirementsOrder("{controlId}")),
    responses: {
      // The tag is the whole set's, so it is the same on every page of it.
      "200": versioned("A page of requirements.", collection(requirementResponse), setTag),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
    },
  },
  {
    method: "put",
    path: `${controls}/{controlId}/requirements`,
    summary: "Set which requirements a control answers to, replacing the whole set.",
    parameters: [
      {
        ...conditional,
        description:
          "The set's ETag, as every page of it was read. Supplied, the replacement is refused " +
          "with 412 if the set has changed since; `*` means only if the control still exists.",
      },
    ],
    request: controlRequirementsBody,
    responses: {
      "200": versioned(
        "The set as it now stands.",
        single(controlRequirementsResponse),
        "The version of the set as it now stands. Quote it in `If-Match` to change it again.",
      ),
      "400": fails("The body is not valid, or names a requirement that is not here."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
      "412": fails("The requirements changed since they were read."),
      "413": fails("The body is too large."),
    },
  },
  {
    method: "get",
    path: standards,
    summary: "List the standards the organization has imported, newest first.",
    query: collectionQuery(standardOrder),
    responses: {
      "200": responds("A page of standards.", collection(standardResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such organization, or the caller is not a member of it."),
    },
  },
  {
    method: "post",
    path: standards,
    summary: "Import a standard with the requirements it states, in one request.",
    request: importBody,
    responses: {
      "201": responds("The standard that was imported.", single(standardResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such organization, or the caller is not a member of it."),
      "409": fails("That edition of that standard is already here."),
      "413": fails("The body is too large."),
    },
  },
  {
    method: "get",
    path: `${standards}/{standardId}`,
    summary: "Retrieve one standard.",
    responses: {
      "200": responds("The standard.", single(standardResponse)),
      "401": fails("The request is not authenticated."),
      "404": fails("No such standard."),
    },
  },
  {
    method: "get",
    path: `${standards}/{standardId}/requirements`,
    summary: "List a standard's requirements, in the order the standard states them.",
    // Any standard: the published schema is the same whichever it is.
    query: requirementsQuery(requirementOrder("{standardId}")),
    responses: {
      "200": responds("A page of requirements.", collection(requirementResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such standard."),
    },
  },
  {
    method: "get",
    path: `${controls}/{controlId}/evidence`,
    summary: "List a control's evidence, most recently occurred first.",
    // Any control: the published schema is the same whichever it is.
    query: collectionQuery(evidenceOrder("{controlId}")),
    responses: {
      "200": responds("A page of evidence.", collection(evidenceResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
    },
  },
  {
    method: "post",
    path: `${controls}/{controlId}/evidence`,
    summary: "Record evidence for a control. It starts unattested.",
    request: evidenceBody,
    responses: {
      "201": versioned("The evidence that was recorded.", single(evidenceResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such control."),
      "413": fails("The body is too large."),
    },
  },
  {
    method: "get",
    path: `${tenant}/evidence/{evidenceId}`,
    summary: "Retrieve one piece of evidence.",
    responses: {
      "200": versioned("The evidence.", single(evidenceResponse)),
      "401": fails("The request is not authenticated."),
      "404": fails("No such evidence."),
    },
  },
  {
    method: "patch",
    path: `${tenant}/evidence/{evidenceId}`,
    summary: "Change evidence that has not been attested.",
    parameters: [conditional],
    request: evidenceAmendBody,
    responses: {
      "200": versioned("The evidence as it now stands.", single(evidenceResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such evidence."),
      "409": fails("The evidence is attested, and attested evidence does not change."),
      "413": fails("The body is too large."),
      "412": fails("If-Match does not match the evidence's current ETag."),
    },
  },
  {
    method: "delete",
    path: `${tenant}/evidence/{evidenceId}`,
    summary: "Discard unattested evidence, and the files attached to it.",
    parameters: [conditional],
    responses: {
      "204": { description: "The evidence is gone." },
      "401": fails("The request is not authenticated."),
      "404": fails("No such evidence."),
      "409": fails("The evidence is attested, and what was attested is kept."),
      "412": fails("If-Match does not match the evidence's current ETag."),
    },
  },
  {
    method: "put",
    path: `${tenant}/evidence/{evidenceId}/attestation`,
    summary: "Attest evidence, vouching for it. It cannot be changed afterwards.",
    parameters: [
      {
        name: "If-Match",
        in: "header",
        required: true,
        description:
          "The exact strong ETag of the evidence as it was read. Wildcards (`*`), lists and " +
          "weak tags are refused: an attestation endorses that specific version.",
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": responds("The evidence, now attested.", single(evidenceResponse)),
      "401": fails("The request is not authenticated."),
      "403": fails("Attesting is refused while impersonating."),
      "404": fails("No such evidence."),
      "409": fails("The evidence has already been attested."),
      "412": fails("If-Match does not match the evidence's current ETag."),
      "428": fails("If-Match is required."),
    },
  },
  {
    method: "post",
    path: `${tenant}/evidence/{evidenceId}/file-uploads`,
    summary: "Authorize an upload, and get a URL to send the bytes to.",
    description:
      "Attaching a file takes three requests. This one authorizes it and answers with a " +
      "short-lived signed URL; send the bytes there with a single `PUT`; then complete the " +
      "upload to attach the file. Your bytes never pass through this API, so nothing here " +
      "bounds how large a request may be — the file is bounded instead, at " +
      `${maxFileBytes} bytes, measured from what the store ends up holding.`,
    request: prepareUploadBody,
    responses: {
      "201": responds("An upload, and where to send the bytes.", single(fileUploadResponse)),
      "400": fails("The body is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such evidence."),
      "409": fails("The evidence is attested, or already carries as many files as it may."),
      "413": fails("The declared size is larger than a file may be."),
    },
  },
  {
    method: "put",
    path: `${tenant}/file-uploads/{uploadId}/completion`,
    summary: "Attach the uploaded bytes to the evidence, once they have been sent.",
    description:
      "Checks what the store actually holds — its size, and its SHA-256 as this server " +
      "computed it — and records the file. Safe to retry: an upload that has already been " +
      "completed answers with the same file rather than attaching a second one.",
    responses: {
      "200": responds("The file that was attached.", single(fileResponse)),
      "400": fails("The uploaded object is empty."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such upload."),
      "409": fails(
        "Nothing was uploaded, the bytes changed while they were being checked, or the " +
          "evidence is attested or already carries as many files as it may.",
      ),
      "410": fails("The upload window has closed."),
      "413": fails("The uploaded object is larger than a file may be."),
    },
  },
  {
    method: "get",
    path: `${tenant}/files/{fileId}`,
    summary: "Download a file's contents.",
    description:
      "Answers `303` with a short-lived signed URL for the bytes, which are served as an " +
      "attachment. Follow the redirect; do not keep the URL.",
    responses: {
      "303": {
        description: "Where to read the bytes, for the next minute.",
        headers: {
          Location: { schema: { type: "string" }, description: "A short-lived signed URL." },
        },
      },
      "401": fails("The request is not authenticated."),
      "404": fails("No such file."),
    },
  },
  {
    method: "get",
    path: `${tenant}/requirements/{requirementId}`,
    summary: "Retrieve one requirement, without going through its standard.",
    responses: {
      "200": responds("The requirement.", single(requirementResponse)),
      "401": fails("The request is not authenticated."),
      "404": fails("No such requirement."),
    },
  },
  {
    method: "get",
    path: `${tenant}/requirements/{requirementId}/controls`,
    summary: "List the controls that answer to a requirement, newest first.",
    // Any requirement: the published schema is the same whichever it is.
    query: collectionQuery(requirementControlsOrder("{requirementId}")),
    responses: {
      "200": responds("A page of controls.", collection(controlResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such requirement."),
    },
  },
  {
    method: "get",
    path: `${tenant}/requirements/{requirementId}/evidence`,
    summary:
      "List the evidence recorded for the controls mapped to a requirement, most recently " +
      "occurred first. A mapping is not a claim of coverage.",
    // Any requirement: the published schema is the same whichever it is.
    query: collectionQuery(requirementEvidenceOrder("{requirementId}")),
    responses: {
      "200": responds("A page of evidence.", collection(evidenceResponse)),
      "400": fails("The query is not valid."),
      "401": fails("The request is not authenticated."),
      "404": fails("No such requirement."),
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
      ...(operation.description ? { description: operation.description } : {}),
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
        "lives under an organization, and a caller must be a member of it. A collection " +
        "refuses query parameters it does not know rather than ignoring them.",
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
