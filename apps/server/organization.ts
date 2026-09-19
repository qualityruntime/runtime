// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The organization a request acts in, resolved once before any handler runs.
 *
 * Which organization comes from the URL, not from the session — reasoning in
 * `docs/adr/0004-organization-in-the-request-path.md`. This module turns that
 * path segment into a membership, and refuses the request if there isn't one.
 */

import {
  idPattern,
  type RootDatabase,
  schema,
  type TenantTransaction,
  withOrganization,
} from "@qualityruntime/db";
import { and, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import { createMiddleware } from "hono/factory";
import { type Actor, type RecordChange, recordChange } from "./audit.ts";
import type { Auth } from "./auth.ts";
import { failure } from "./responses.ts";

type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

const isOrganizationId = new RegExp(idPattern("organization"));

/** What every handler behind this middleware can rely on. */
export type OrganizationEnv = {
  Variables: {
    /** The authenticated caller. */
    user: Session["user"];
    /** Their membership of this organization — the authorization decision, kept. */
    member: typeof schema.member.$inferSelect;
    /**
     * Runs tenant-owned work scoped to this request's organization. Bound, so a
     * handler cannot scope to an organization the caller was not authorized for.
     */
    withOrganization: <T>(
      work: (tx: TenantTransaction) => Promise<T>,
      options?: { repeatableRead?: boolean },
    ) => Promise<T>;
    /**
     * Records a change on the transaction that makes it. Bound to the caller
     * for the same reason: a handler says what happened, never who did it.
     */
    audit: RecordChange;
    /**
     * Who the request is attributable to, resolved once. Handlers that record
     * attribution of their own — an attestation, say — take it from here
     * rather than from `user`, which under impersonation is the member being
     * acted as rather than the administrator acting.
     */
    actor: Actor;
  };
};

/**
 * Requires an authenticated caller who is a member of `:organizationId`.
 *
 * A caller who is not a member gets 404 rather than 403. 403 would confirm that
 * an organization exists, turning any leaked or guessed identifier into a
 * membership oracle; a non-member should not be able to tell an organization
 * they cannot see from one that is not there.
 */
export function organizationContext<Q extends PgQueryResultHKT>({
  auth,
  db,
}: {
  auth: Auth;
  db: RootDatabase<Q>;
}) {
  return createMiddleware<OrganizationEnv>(async (c, next) => {
    // Every response here depends on who asked, so no shared cache may reuse
    // one: a hit would serve another tenant's rows, or deny a member on a
    // cached refusal. Applied before anything can return.
    c.header("cache-control", "no-store");

    // `returnHeaders` because `getSession` renews an ageing session and issues
    // the replacement cookie in those headers. Taking only the body would keep
    // extending the session in the database while never telling the browser,
    // which then signs out at the original expiry despite being active.
    const { headers, response: session } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) {
      c.header("set-cookie", cookie, { append: true });
    }

    if (!session) {
      return c.json(failure("unauthenticated", "Sign in to make this request."), 401);
    }

    // Authorization, and the only thing that decides it: `session` may carry an
    // `activeOrganizationId`, but that is context, never proof of access
    // (TENANT-01).
    const organizationId = c.req.param("organizationId");
    if (!organizationId) {
      // A routing mistake, not a bad request: this middleware is only correct
      // on a path that carries the segment.
      throw new Error("organizationContext requires an :organizationId path segment.");
    }

    // A segment that could not name an organization is not one, so it gets the
    // same answer as one the caller is not in. It never reaches PostgreSQL —
    // a NUL in `text` fails the statement, which would surface as a 500 for
    // what is plainly an absence.
    if (!isOrganizationId.test(organizationId)) {
      return c.json(failure("not_found", "No such organization."), 404);
    }

    const [membership] = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, organizationId),
          eq(schema.member.userId, session.user.id),
        ),
      );
    if (!membership) {
      return c.json(failure("not_found", "No such organization."), 404);
    }

    c.set("user", session.user);
    c.set("member", membership);
    // Better Auth's admin plugin can impersonate: `session.user` is then the
    // member being acted as, and `impersonatedBy` the administrator doing it.
    // The administrator is the actor — attributing their change to the member
    // would be a false record, which is worse than none (AUDIT-01).
    const impersonator = session.session.impersonatedBy;
    // Only the id is on the session, so the name costs a look-up — on the rare
    // impersonated request only, and worth it there: the label is what still
    // names the accountable person once their account is gone (ADR 0005).
    const [administrator] = impersonator
      ? await db
          .select({ name: schema.user.name })
          .from(schema.user)
          .where(eq(schema.user.id, impersonator))
      : [];
    const actor: Actor = impersonator
      ? {
          type: "user",
          id: impersonator,
          label: administrator?.name || null,
          onBehalfOf: { id: session.user.id, label: session.user.name || null },
        }
      : { type: "user", id: session.user.id, label: session.user.name || null };

    c.set("actor", actor);
    c.set("audit", (tx, change) => recordChange(tx, actor, organizationId, change));
    // The driver is erased here so handlers need not be generic over it; every
    // transaction method a handler uses is identical across drivers.
    c.set("withOrganization", ((work, options) =>
      withOrganization(
        db,
        organizationId,
        work,
        options,
      )) as OrganizationEnv["Variables"]["withOrganization"]);

    await next();

    // A handler that returned a `Response` of its own bypasses the prepared
    // headers above, and this one is not optional. Rebuilt rather than mutated
    // because a proxied response can carry immutable headers.
    if (c.res.headers.get("cache-control") !== "no-store") {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("cache-control", "no-store");
    }
  });
}
