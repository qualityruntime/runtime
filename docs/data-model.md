# Data model

What Quality Runtime knows: entities, relationships, organization scoping, identifiers, lifecycle state, versioning, and the invariants the schema enforces.

The schema lives in [`packages/db`](../packages/db): table definitions in `schema/`, checked-in SQL in `migrations/`.

## Identity and tenancy

These tables are owned by [Better Auth](https://better-auth.com) and defined in `schema/auth.ts`. See [ADR 0001](adr/0001-drizzle-orm-and-better-auth.md) for why, and for the deviations from its generated schema.

| Table          | Holds                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| `user`         | A person. Instance-wide identity, independent of any organization                      |
| `account`      | A credential or linked social provider; unique per (provider, external id)             |
| `session`      | An authenticated session, including the organization it is acting in                   |
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

A row identifier is not a credential: `session.token` authenticates a session and `verification.value` proves a verification. `invitation` is wider because Better Auth takes an invitation by id. Identifiers are allocated before insertion and reveal no row count. Each `id` column enforces its table's prefix, length, and alphabet with a CHECK constraint, so an identifier belonging to another table — or one carrying uppercase — is rejected rather than stored. Join tables need no separate identifier: `control_requirement` uses `(control_id, requirement_id)` as its primary key.

## Domain entities

Quality and compliance entities — documents, requirements, controls, evidence, risks, audits, findings, incidents, CAPAs, training, suppliers, approvals, and workflows — are not implemented yet. They join the same package and the same migration history, and each carries the organization it belongs to.
