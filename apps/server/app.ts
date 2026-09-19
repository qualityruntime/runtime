// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

import type { RootDatabase } from "@qualityruntime/db";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Scalar } from "@scalar/hono-api-reference";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type Auth, sessionCookieName } from "./auth.ts";
import { controls } from "./controls.ts";
import { failure } from "./responses.ts";
import { openApiDocument, openApiPath, referencePath } from "./openapi.ts";
import { organizationContext } from "./organization.ts";
import { evidence } from "./evidence.ts";
import { history } from "./history.ts";
import { requirements } from "./requirements.ts";
import { standards } from "./standards.ts";

/**
 * The HTTP surface.
 *
 * Better Auth owns every route under `/api/auth` and validates methods itself,
 * so every method is forwarded. That is Better Auth's own API, not this
 * product's public one, which lives under `/api/v1`.
 *
 * Every tenant-owned resource sits under `/api/v1/organizations/:organizationId`
 * behind `organizationContext`, which resolves the caller's membership before
 * any handler runs (ADR 0004). Mounted anywhere else, a handler would find no
 * `withOrganization` on its context and fail rather than serve unscoped rows.
 *
 * Unmatched paths and uncaught errors answer in the same failure shape as the
 * routes, so a client has one thing to parse. Better Auth is untouched by any
 * of it: it answers `/api/auth/*` itself, so no request there reaches the
 * not-found handler, and its own responses and limits are its contract.
 */
export function createApp<Q extends PgQueryResultHKT>({
  auth,
  db,
  apiReferenceBundleUrl,
}: {
  auth: Auth;
  db: RootDatabase<Q>;
  /**
   * Where the rendered reference loads its bundle from, when not the CDN.
   *
   * Passed in rather than read from `process.env` here: this is core, and core
   * must not know how a deployment keeps its configuration (ARCH-01).
   */
  apiReferenceBundleUrl?: string;
}) {
  const tenant = "/api/v1/organizations/:organizationId";

  /**
   * How much of a body each route may read, decided before any of it is read.
   *
   * A body is read and parsed in full before a validator sees it, so the field
   * bounds in a route schema do not bound the work a request costs. One figure
   * cannot serve every route: 64 KiB refuses a legitimate standard, and a
   * standard's allowance would let every other route accept one.
   *
   * It has to be chosen here rather than on the route. A limiter with no
   * `Content-Length` to go on buffers the stream before passing it down, so a
   * generous limit in front of a strict one is simply the generous one.
   */
  const tooLarge = (c: Context) =>
    c.json(failure("payload_too_large", "The request body is too large."), 413);
  const ordinary = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  // A standard arrives whole, with the text of every clause it states (ADR 0009).
  const standardImport = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  const importsAStandard = (c: Context) =>
    c.req.method === "POST" && /^\/api\/v1\/organizations\/[^/]+\/standards$/.test(c.req.path);

  return (
    new Hono()
      .notFound((c) => c.json(failure("not_found", "No such endpoint."), 404))
      .onError((error, c) => {
        if (error instanceof HTTPException) {
          // Hono raises these before a handler runs — a malformed JSON body, for
          // one. Its own response is plain text, so the envelope is rebuilt here
          // unless the thrower supplied a response of its own.
          if (error.res) return error.res;
          const code = error.status >= 500 ? "internal" : "invalid_request";
          return c.json(failure(code, error.message), error.status);
        }
        // Anything else is a bug here: logged in full, reported without details.
        console.error(error);
        return c.json(failure("internal", "The request could not be completed."), 500);
      })
      .all("/api/auth/*", (c) => auth.handler(c.req.raw))
      // Ahead of the organization prefix and outside it: the document describes
      // the API, not anyone's data, and belongs to no tenant.
      .get(openApiPath, (c) => c.json(openApiDocument(sessionCookieName(auth))))
      // The same document, rendered. Reads the JSON above by URL, so nothing
      // about how it is built depends on this (ADR 0007).
      .get(
        referencePath,
        Scalar({
          url: openApiPath,
          pageTitle: "Quality Runtime API",
          // Scalar loads its own bundle from a CDN. A deployment that cannot
          // reach one points this at its own copy (ADR 0015).
          ...(apiReferenceBundleUrl ? { cdn: apiReferenceBundleUrl } : {}),
        }),
      )
      .use("/api/v1/*", (c, next) => (importsAStandard(c) ? standardImport : ordinary)(c, next))
      .use(`${tenant}/*`, organizationContext({ auth, db }))
      .route(tenant, controls)
      .route(tenant, history)
      .route(tenant, standards)
      .route(tenant, requirements)
      .route(tenant, evidence)
  );
}
