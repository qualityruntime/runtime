# Data model

What Quality Runtime knows: entities, relationships, organization scoping, identifiers, lifecycle state, versioning, and the invariants the schema enforces.

The schema lives in [`packages/db`](../packages/db): table definitions in `schema/`, checked-in SQL in `migrations/`.

## Identity and tenancy

These tables are owned by [Better Auth](https://better-auth.com) and defined in `schema/auth.ts`. See [ADR 0001](adr/0001-drizzle-orm-and-better-auth.md) for why, and for the deviations from its generated schema.

| Table          | Holds                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| `user`         | A person. Instance-wide identity, independent of any organization                      |
| `account`      | A credential or linked social provider; unique per (provider, external id)             |
| `session`      | An authenticated session, and the organization the user last selected                  |
| `verification` | Short-lived tokens for email verification, password reset, and OTP delivery            |
| `two_factor`   | TOTP secrets and backup codes                                                          |
| `organization` | **The tenant boundary.** Every tenant-owned record belongs to exactly one organization |
| `member`       | A user's membership and role in an organization; unique per (org, user)                |
| `invitation`   | An invitation to join an organization, including its status                            |

## Identifiers

Every generated row identifier uses `<prefix>_<random>`, for example `usr_v1stgxr8z5jdhi6b`. The prefix identifies the record type, and the random portion is a lowercase base36 value generated with [Nano ID](https://github.com/ai/nanoid). [ADR 0002](adr/0002-prefixed-identifiers.md) documents the decision. `packages/db/id.ts` is the single place where identifiers are generated.

| Table          | Prefix | Random length |
| -------------- | ------ | ------------- |
| `invitation`   | `inv_` | 24            |
| `user`         | `usr_` | 16            |
| `session`      | `ses_` | 16            |
| `account`      | `acc_` | 16            |
| `verification` | `ver_` | 16            |
| `organization` | `org_` | 16            |
| `member`       | `mem_` | 16            |
| `two_factor`   | `tfa_` | 16            |
| `control`      | `ctl_` | 16            |
| `audit_event`  | `aud_` | 16            |
| `standard`     | `std_` | 16            |
| `requirement`  | `req_` | 16            |
| `evidence`     | `evd_` | 16            |
| `file`         | `fil_` | 16            |

A row identifier is not a credential: `session.token` authenticates a session and `verification.value` proves a verification. `invitation` is wider because Better Auth takes an invitation by id. Identifiers are allocated before insertion and reveal no row count. Each `id` column enforces its table's prefix, length, and alphabet with a CHECK constraint, so an identifier belonging to another table — or one carrying uppercase — is rejected rather than stored. Join tables need no separate identifier: `control_requirement` uses `(control_id, requirement_id)` as its primary key.

## Domain entities

Domain tables are tenant-owned: each carries an `organization_id` referencing the organization it belongs to, and deleting an organization deletes its rows. That column records **ownership, not permission** — it says which tenant a row belongs to, never that a given request may read or change it. Authorization still resolves the caller's `member` row (TENANT-01, and see [security](security.md)).

PostgreSQL enforces the boundary: every table here has row-level security enabled and forced, and is reached through `withOrganization`, which scopes a transaction to one organization. A query that forgets its tenant predicate returns that organization's rows rather than everyone's, and a transaction with no organization set sees nothing. [ADR 0003](adr/0003-tenant-isolation-with-row-level-security.md) records the design; adding a tenant-owned table means adding its policy, and `migrations.test.ts` fails until you do.

| Table         | Holds                                                    |
| ------------- | -------------------------------------------------------- |
| `control`     | A measure an organization operates to meet a requirement |
| `audit_event` | A change to a record: who, what, when, and from what     |

### Control

A control is something an organization does to satisfy a requirement — a measure, a practice, a safeguard. It is defined in `schema/control.ts` and is deliberately narrow: the organization it belongs to, a name, an optional description, and a lifecycle status.

Lifecycle:

```text
gone ◀── draft ──▶ active ──▶ retired
```

- `draft` — being authored; claims nothing.
- `active` — in effect, and may be relied on as evidence of coverage.
- `retired` — no longer in effect, but kept: a control that once covered a requirement is part of the record. Retiring is what deletion should usually be.

The schema admits exactly these three values and no more. The API answers for the moves between them — the arrows above are the only ones — and setting the status a control already has is a no-op. The lifecycle runs one way, and PostgreSQL holds it to that whatever writes the row ([ADR 0017](adr/0017-discarding-a-draft-control.md)). A control in effect is withdrawn deliberately rather than quietly returned to draft, and a withdrawn one stays withdrawn: what replaces it is a new control, so the one evidence was recorded against keeps meaning what it meant. There is no `active → draft`, and nothing leaves `retired`. A control is always created as a `draft`; the create request cannot choose otherwise.

**A control that was never in effect can be discarded** ([ADR 0017](adr/0017-discarding-a-draft-control.md)). `DELETE` removes it outright, and answers 409 otherwise. The reason is the one above: retiring preserves a control that was once relied on, and one that never took effect was not — there is nothing to preserve, and calling it `retired` would claim it had been in effect.

The `DELETE` policy admits only a `draft`, and PostgreSQL is what makes "draft" mean "never took effect" rather than the API. `activated_at` records when a control first became active; a trigger sets it and refuses any other write to it, and a CHECK allows a draft exactly when it is null. So nothing that was in effect can be a draft again — not through the API, and not through raw SQL, including an `UPDATE` and a `DELETE` in one transaction. The trigger has to be a trigger: a policy cannot compare a row to what it used to be, and anything able to clear the stamp could turn a control that was in effect back into a deletable draft.

A control still carrying evidence is refused too, because `evidence` restricts rather than cascades: attested evidence has to go on naming what it was evidence of. Discarding a control takes its requirement mappings with it, by cascade, and a cascade is not audited.

The deletion itself is audited, and that history outlives the row: `resource_id` is a plain column, not a reference. It stays readable afterwards at `GET /history?resource={controlId}` — a history reachable only through a live record would disappear exactly when it is most wanted ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)).

Names are not unique within an organization: a name is a label, not an identifier, and two teams authoring similar controls is a state to reconcile rather than one to reject at insert time. A name that is blank or only whitespace is rejected.

Fields a quality system eventually wants — category, framework, test method, review cadence, effectiveness, owner — are deliberately absent until a workflow needs them. Ownership in particular waits on how domain responsibility should relate to Better Auth membership.

A control row is mutable: editing one overwrites it. What it was is recorded in `audit_event` rather than kept on the row, so the history of a control is a query rather than a column. Versioned prior states (VERSION-01) — a numbered revision a reader can cite and return to — are still not implemented, and are a separate thing from the change log below.

### Audit event

Domain API mutations record changes in the same transaction as the change itself ([ADR 0005](adr/0005-audit-history.md)). A change PostgreSQL makes on its own — a foreign key's cascade removing rows — writes nothing, which is a known gap rather than a decision. It names the actor, the action, the record, and the fields that moved.

| Column                         | Holds                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `actor_type`, `actor_id`       | Who acted: `user` or `system`, and their identifier                              |
| `actor_label`                  | How the actor was named at the time                                              |
| `action`                       | A verb — `created`, `updated`, `deleted`                                         |
| `resource_type`, `resource_id` | Which record it happened to                                                      |
| `before`, `after`              | The fields that changed; `before` is null for a creation, `after` for a deletion |
| `created_at`                   | When the change happened, not when the row was written                           |

An administrator impersonating a member is the actor, because they are accountable for what happened; the member is recorded as whose account it went through.

Neither `actor_id` nor `resource_id` is a foreign key. Both the actor and the record can be deleted, and history that vanishes with them is not history (AUDIT-01) — `actor_label` exists for the same reason, since an identifier alone means nothing to a reader once the row is gone.

`before` and `after` carry a record's own fields, and for an update only the ones that differ. Record identity is already a column, and bookkeeping timestamps (`created_at`, `updated_at`) describe the write rather than the change. A domain timestamp — when something happened, rather than when it was written — is a field like any other. An update that changes nothing writes no event at all.

History is readable at `GET /api/v1/organizations/{organizationId}/history`, newest first and paged like every other collection ([ADR 0006](adr/0006-cursor-paged-collections.md)). `?resource={id}` narrows it to one record, named by its identifier alone since the identifier says what kind it is. There is no per-record route and no 404: history outlives what it describes, so there is nothing to look a resource up in, and what a caller may see is decided by the policies ([ADR 0018](adr/0018-one-history-rather-than-one-per-record.md)).

**The table is append-only to the application.** Row-level security grants a tenant `SELECT` and `INSERT` and names no other command, so no code path can rewrite or erase an event through its tenant context. `TRUNCATE` and the privileges of the role that owns the table are outside row security, so preventing the runtime role from rewriting or erasing history also requires restricted privileges — see [deployment](deployment.md). Deleting an organization still removes its history, through the foreign key's cascade.

### Changing only what you read

Amending or discarding a control accepts `If-Match`, and answers `412` when the version it names has moved ([ADR 0019](adr/0019-conditional-writes.md)). A record's version is PostgreSQL's `xmin` — the transaction that last wrote the row — served as an `ETag` on reading a control and on a successful amendment, so a client can make a second edit without reading again.

The header is optional: omitting it leaves writes last-writer-wins.

### Not implemented yet

Documents, risks, audits, findings, incidents, CAPAs, training, suppliers, approvals, and workflows. They join the same package and the same migration history.
