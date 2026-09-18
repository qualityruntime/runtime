// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON envelopes for domain API responses.
 *
 * A record uses `data`, a collection adds `nextCursor` (ADR 0006), and a
 * failure uses `error` (ADR 0004). `failure` builds error responses; `single`
 * and `collection` build schemas for documentation and tests. Handlers build
 * successful responses themselves; 204 responses have no envelope.
 */

import { z } from "zod";

/** Which part of the request was wrong, and why. Omitted when nothing is. */
export type Detail = { path: string; message: string };

export const failure = (code: string, message: string, details?: Detail[]) => ({
  error: details?.length ? { code, message, details } : { code, message },
});

/**
 * `code` is what a client branches on and is part of the contract; `message` is
 * for a human reading a log and may be reworded. Neither carries anything the
 * caller is not already entitled to know.
 */
export const failureResponse = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    details: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  }),
});

/** One record. */
export const single = <T extends z.ZodType>(item: T) => z.strictObject({ data: item });

/** A page of records, and where the next one starts — null on the last. */
export const collection = <T extends z.ZodType>(item: T) =>
  z.strictObject({ data: z.array(item), nextCursor: z.string().nullable() });
