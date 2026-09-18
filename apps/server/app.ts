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
import { history } from "./history.ts";

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
   * must not know how a deployment keeps its configuration (ARCH-01). A Workers
   * entry has no `process.env` at all — its environment arrives per request.
   */
  apiReferenceBundleUrl?: string;
}) {
  const tenant = "/api/v1/organizations/:organizationId";

  /**
   * How much of a body a route may read, decided before any of it is read.
   *
   * A body is read and parsed in full before a validator sees it, so the field
   * bounds in a route schema do not bound the work a request costs. Chosen
   * here rather than on the route: a limiter with no `Content-Length` to go on
   * buffers the stream before passing it down, so a route that needs a
   * different allowance has to be told apart here, ahead of this one.
   */
  const tooLarge = (c: Context) =>
    c.json(failure("payload_too_large", "The request body is too large."), 413);

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
      .use("/api/v1/*", bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }))
      .use(`${tenant}/*`, organizationContext({ auth, db }))
      .route(tenant, controls)
      .route(tenant, history)
  );
}
