// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request body and query validation for `/api/v1`.
 *
 * Hono's own `validator` does the plumbing; this only decides what a rejection
 * looks like, which is part of the API contract rather than of any one route.
 */

import { validator } from "hono/validator";
import { z } from "zod";
import { failure } from "./responses.ts";

/**
 * PostgreSQL `text` cannot hold a NUL, and rejects the whole statement if asked
 * to. A body carrying one is a bad request, not a server error.
 *
 * A pattern rather than a refinement so that it survives into the published
 * JSON Schema: a refinement converts to nothing, and a document that accepts
 * what the server rejects is worse than no document (ADR 0007).
 */
// oxlint-disable-next-line no-control-regex -- a NUL is precisely the point
const withoutNul = /^[^\u0000]*$/;

/**
 * A short line someone typed: bounded, not blank, and trimmed.
 *
 * Every rule is checked against what the client sent and the value is trimmed
 * afterwards. Trimming first would mean the published bounds described a string
 * nobody sent — 200 characters with a space in front would be accepted by the
 * server and refused by its own schema (ADR 0007).
 */
export const words = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(withoutNul)
    .regex(/\S/)
    .transform((value) => value.trim())
    .meta({ description: "Surrounding whitespace is removed once the length is checked." });

/** Longer text, which may be empty once trimmed. */
export const prose = (max: number) =>
  z
    .string()
    .max(max)
    .regex(withoutNul)
    .transform((value) => value.trim());

/**
 * The rejection names every field that was wrong, because a 400 a client cannot
 * act on is barely better than a 500.
 *
 * `path` is `""` for an issue about the input as a whole, such as a rule
 * spanning fields, rather than a made-up field name.
 */
export const rejection = (what: string, error: z.ZodError) =>
  failure(
    "invalid_request",
    `The request ${what} is not valid.`,
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );

/**
 * Parses a JSON body against `schema`, answering 400 when it does not fit.
 *
 * The supplied schema decides how to handle unknown properties: control
 * bodies strip them, while standard imports reject them.
 */
export const jsonBody = <T extends z.ZodType>(schema: T) =>
  validator("json", (value, c) => {
    const result = schema.safeParse(value);
    return result.success ? result.data : c.json(rejection("body", result.error), 400);
  });

/**
 * Parses the query string against `schema`, answering 400 when it does not fit.
 *
 * Hono supplies a string for a single value and an array for repeated keys.
 * The schema decides what to accept and coerce, such as a numeric limit or
 * an encoded cursor.
 */
export const queryParams = <T extends z.ZodType>(schema: T) =>
  validator("query", (value, c) => {
    const result = schema.safeParse(value);
    return result.success ? result.data : c.json(rejection("query", result.error), 400);
  });
