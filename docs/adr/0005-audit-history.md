# 5. Audit history

Date: 2026-09-18

## Status

Accepted

## Context

Material changes must leave durable history: what changed, who or what changed it, when, to which record, and from what state (AUDIT-01). Until now nothing did — `docs/data-model.md` said so in as many words, because a control was mutable and kept nothing.

This is worth settling while `control` is the only mutable domain entity. Auditing is not a feature that can be added to six entities afterwards: the shape it takes decides how every mutation is written, and history that begins halfway through a system's life has a hole in it that cannot be filled.

## Decision

One table, `audit_event`, recording changes to records. Every mutating handler writes one **in the same transaction as the change it describes**.

```ts
await c.var.withOrganization(async (tx) => {
  const [created] = await tx.insert(control).values(…).returning();
  await c.var.audit(tx, { action: "created", resourceType: "control", resourceId: created.id, after: … });
});
```

What decides the shape:

**Attribution outlives the actor.** `actor_id` is not a foreign key to `user`, which cascades on deletion — history that disappears with the person who made it is not history. Alongside it, `actor_label` keeps how the actor was named at the time, because a bare `usr_…` tells a later reader nothing once the row is gone. `resource_id` is not a foreign key either, for the same reason: a record's history must survive the record.

**The actor is whoever is accountable.** Better Auth's admin plugin can put an administrator inside a member's session. Attributing what they then do to the member would be a false record, which is worse than no record — so the administrator is the actor, and `on_behalf_of_id` says whose account it happened through. Those columns exist now rather than later because impersonation is reachable today: every change made through it before the columns existed would be attributed to the wrong person, permanently.

**The actor has a type from the start.** Only `user` is written today, but people are not the only things that will change a control — background work, integrations, and agents all will. An actor type cannot be introduced later without inventing one for every row already written, so `actor_type` exists now with `system` reserved for the first of those. A CHECK constrains the set, and a second CHECK requires a `user` event to name a user.

**An event is timed when it happens.** `created_at` defaults to `clock_timestamp()`, not `now()`. `now()` is fixed for a whole transaction, and two requests changing the same record serialize on its row lock — so the one that _started_ first can commit second, and transaction-start order would put that record's history backwards.

**Events describe records, not everything.** `resource_type` and `resource_id` are required, and `action` is a bare verb — `created`, `updated`, `attested`, `deleted`. Authentication events are Better Auth's business, and a log of everything that ever happened is a different thing from the history of a record.

**Only what changed is stored.** `before` and `after` hold a record's own fields, and for an update only the ones that differ; `before` is null for a creation. Identity is already a column, bookkeeping timestamps describe the write rather than the change, and an update that changes nothing writes no event at all — a request that set the values a record already had would otherwise bury the ones that did something.

**Append-only, enforced by PostgreSQL.** A tenant-owned table normally gets one policy covering every command ([ADR 0003](0003-tenant-isolation-with-row-level-security.md)). Audit history needs less:

```sql
CREATE POLICY "audit_event_tenant_read"   ON "audit_event" FOR SELECT USING (…);
CREATE POLICY "audit_event_tenant_append" ON "audit_event" FOR INSERT WITH CHECK (…);
```

There is no UPDATE or DELETE policy. With row security forced and no policy naming those commands, no row is visible to either, so an attempt matches nothing — the application cannot rewrite or erase history through its tenant context, whatever its code says.

A trigger raising an exception was considered and rejected. It would fire on the foreign key's cascade as well, and make deleting an organization fail. Deleting an organization does still remove its history, because PostgreSQL runs a cascade as an internal referential action that row security does not apply to.

**Policies are half of it; grants are the other half.** `TRUNCATE` is not subject to row security at all, and a role that owns the table can disable the policies outright — so policies alone do not protect history from a compromised request path using an owning role. Preventing the runtime role from rewriting or erasing history requires it not to own these tables and not to hold `TRUNCATE`, `UPDATE`, or `DELETE` on `audit_event`. These restrictions prevent mutation by that role; they do not provide tamper detection for changes made by a privileged operator. Privilege setup belongs to deployment rather than to a migration; `docs/deployment.md` states the requirements for audit integrity.

## Consequences

Every mutating handler now has a second thing it must do, and forgetting it is silent. Two things make that unlikely rather than impossible: `audit` arrives on the request already bound to the caller and their organization, so a handler chooses what happened but never who did it or where; and the write takes the transaction, so it cannot be deferred to after the response, where it would be a second source of truth that can disagree with the first.

Auditing is not free. Every create and every meaningful update costs an extra insert in the same transaction, and the table grows without bound. That is the intended trade: this is the record a quality system exists to keep. Retention, archival, and how far back a deployment must keep events are real questions, and none of them is answered here.

`before` and `after` are `jsonb` with no schema. That is deliberate — a typed column per field per entity does not generalize — but it means nothing stops a handler writing a shape no reader expects. `fieldsOf` and `diffFields` exist so that handlers do not each invent one, and the resource's own module names the fields it audits.

Removing a user still removes their name from `user`; `actor_label` keeps a copy. A deployment with an erasure obligation therefore has an audit log to think about, and the alternative — history that says an unknown identifier did something — would not satisfy AUDIT-01. It is recorded here as a known tension rather than solved.

The two configurations therefore give different guarantees, and the difference is not cosmetic. `apps/server/audit.test.ts` exercises both: the ordinary tests run as the table owner and show that no application code path can alter an event, and one runs as a non-owner runtime role with only `SELECT` and `INSERT` granted, where `TRUNCATE` and a direct `UPDATE` are refused outright. Privilege separation is now the documented default ([ADR 0014](0014-the-runtime-role-owns-nothing.md)), so "append-only" here means against the runtime role, not only against the code.

`GET /controls/{controlId}/history` read it, paged by cursor ([ADR 0006](0006-cursor-paged-collections.md)) — which is the order this was done in on purpose, because an audit log is the collection least able to tolerate an offset. That route has since been replaced by one organization-wide history, for the reason this ADR gives above: these rows outlive the records they describe, so reaching them through a live record was never going to hold ([ADR 0018](0018-one-history-rather-than-one-per-record.md)).
