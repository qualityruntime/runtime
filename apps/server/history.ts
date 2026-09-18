// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading audit history.
 *
 * `audit.ts` is how an event is written; this is how one is read. The two are
 * deliberately separate: what a change records is a rule every mutating handler
 * follows, and what history a caller may ask for is a route.
 *
 * One collection, filterable, rather than a history route per entity. Audit
 * rows outlive the records they describe — that is the point of them — so a
 * history reachable only through a live record is one that disappears exactly
 * when it is most wanted (ADR 0018).
 */

import { type IdType, idPattern, schema } from "@qualityruntime/db";
import { resourceTypes } from "./audit.ts";
import { and, eq, getTableColumns } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { OrganizationEnv } from "./organization.ts";
import {
  collectionQuery,
  cursorAt,
  newestFirst,
  orderedBy,
  page,
  rowsAfter,
} from "./pagination.ts";
import { rejection } from "./validation.ts";

/** Exactly what `audit.ts` records against, so the two cannot drift apart. */
const resources = resourceTypes satisfies readonly IdType[];

/**
 * Which record an identifier belongs to, from the identifier itself.
 *
 * A caller names one thing — the record — and the type comes free, because an
 * identifier here says what it is (ADR 0002). It is needed because the index
 * that serves this leads with `resource_type`, so a query naming only the id
 * would sort the organization's whole history to answer.
 */
function resourceOf(id: string): { resourceType: string; resourceId: string } | undefined {
  const type = resources.find((each) => new RegExp(idPattern(each)).test(id));
  return type ? { resourceType: type, resourceId: id } : undefined;
}

/**
 * Exactly the identifiers `resourceOf` can place, as one pattern.
 *
 * Built from the same source, so a new resource type cannot be accepted by one
 * and unrecognised by the other. A pattern rather than a refinement, so it
 * survives into the published schema (ADR 0007).
 */
const isResourceId = new RegExp(resources.map((type) => `(?:${idPattern(type)})`).join("|"));

/**
 * The history being read, scoped to it.
 *
 * A cursor is a position in an ordering, and a filtered history is a different
 * ordering from the whole of one — the same position names different rows. The
 * collection name carries the filter so a cursor cannot cross between them
 * (ADR 0006).
 */
export const historyOrder = (resource?: string) =>
  newestFirst(
    `history${resource ? `/${resource}` : ""}`,
    schema.auditEvent.createdAt,
    schema.auditEvent.id,
  );

/**
 * Which record the history is being narrowed to, if any.
 *
 * Read on its own before anything else, because it decides which ordering the
 * cursor belongs to: validating the cursor first would check it against the
 * unfiltered history and refuse every page after the first.
 */
const narrowing = z.object({
  resource: z
    .string()
    .regex(isResourceId, "Must be the identifier of a record that has history.")
    .optional()
    .meta({
      description:
        "Limit the history to one record. The record need not still exist — history outlives " +
        "what it describes.",
    }),
});

/** What a caller may ask of the history, for the ordering `resource` names. */
export const historyQuery = (resource?: string) =>
  collectionQuery(historyOrder(resource)).extend(narrowing.shape);

export const auditEventResponse = z.strictObject({
  id: z.string(),
  /** Named here, unlike on a record's own routes, because the URL does not. */
  resourceType: z.enum(resources),
  resourceId: z.string(),
  action: z.string(),
  actor: z.strictObject({
    type: z.enum(schema.actorTypes),
    id: z.string().nullable(),
    label: z.string().nullable(),
    onBehalfOf: z.strictObject({ id: z.string(), label: z.string().nullable() }).nullable(),
  }),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * What an audit event looks like over HTTP.
 *
 * Written out rather than returned as the row: the row carries the
 * organization, which the URL already named, and splitting the actor out keeps
 * the columns describing one thing together. It also stops a column added to
 * `audit_event` becoming an API change by accident.
 */
const auditEventShape = (event: typeof schema.auditEvent.$inferSelect) => ({
  id: event.id,
  resourceType: event.resourceType,
  resourceId: event.resourceId,
  action: event.action,
  actor: {
    type: event.actorType,
    id: event.actorId,
    label: event.actorLabel,
    onBehalfOf: event.onBehalfOfId
      ? { id: event.onBehalfOfId, label: event.onBehalfOfLabel }
      : null,
  },
  before: event.before,
  after: event.after,
  createdAt: event.createdAt,
});

export const history = new Hono<OrganizationEnv>().get("/history", async (c) => {
  // Which record, if any, before anything else: the cursor is only meaningful
  // against the ordering that answer names.
  const asked = narrowing.safeParse(c.req.query());
  if (!asked.success) return c.json(rejection("query", asked.error), 400);

  const ordering = historyOrder(asked.data.resource);
  const query = historyQuery(asked.data.resource).safeParse(c.req.query());
  if (!query.success) return c.json(rejection("query", query.error), 400);
  const { limit, cursor, resource } = query.data;

  // The pattern above already refused anything else, so this cannot be
  // undefined — but deriving it is what keeps the query on its index.
  const only = resource ? resourceOf(resource) : undefined;

  const rows = await c.var.withOrganization((tx) =>
    tx
      .select({ ...getTableColumns(schema.auditEvent), cursorAt: cursorAt(ordering) })
      .from(schema.auditEvent)
      .where(
        and(
          only ? eq(schema.auditEvent.resourceType, only.resourceType) : undefined,
          only ? eq(schema.auditEvent.resourceId, only.resourceId) : undefined,
          cursor ? rowsAfter(ordering, cursor) : undefined,
        ),
      )
      .orderBy(...orderedBy(ordering))
      .limit(limit + 1),
  );

  const { rows: found, nextCursor } = page(rows, limit, ordering);
  return c.json({ data: found.map(auditEventShape), nextCursor });
});
