# Architecture

Quality Runtime is the open-source runtime for quality and compliance.

This document records architectural principles and invariants. Implementation details are documented once they exist; significant decisions are recorded as ADRs in `docs/adr/`.

## Principles

- Keep the system modular without introducing unnecessary abstraction.
- Keep domain logic independent of deployment providers.
- Use PostgreSQL as the primary source of truth.
- Prefer a small number of well-defined runtime primitives.
- Keep critical enforcement deterministic and auditable.
- Make important state changes reviewable, versioned, and traceable.
- Prefer standard platform and library capabilities over custom infrastructure.
- Optimize for a small team maintaining the system over a long period.

## System overview

Quality Runtime is being designed as a TypeScript application with these layers:

```text
┌──────────────────────────────┐
│            Web UI            │
│       React + shadcn/ui      │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        Application API       │
│             Hono             │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       Domain / Services      │
│                              │
│ quality, workflows, authz,   │
│ validation, business rules   │
└─────────┬──────────┬─────────┘
          │          │
          ▼          ▼
┌──────────────┐  ┌──────────────┐
│  PostgreSQL  │  │ Runtime      │
│              │  │ capabilities │
└──────────────┘  └──────────────┘
                  storage, jobs,
                  email, AI, etc.
```

Domain mutation rules still live in route handlers, which use a Hono context to resolve the tenant and attribute changes. Extract them when a non-HTTP caller needs them, into functions taking explicit inputs and actor context; PostgreSQL tenant scoping and audit recording are already available independently of Hono.

Deployment environments sit outside the core application:

```text
                 Quality Runtime
                       │
              platform-neutral core
                       │
          ┌────────────┴────────────┐
          │                         │
       Docker                   Cloudflare
```

Docker is the canonical self-hosted deployment.

Cloudflare Workers is a first-class deployment design target without being an architectural dependency. Current deployment support is documented in `docs/deployment.md`.

## Dependency direction

Keep dependency direction explicit and infrastructure coupling minimal:

```text
UI → Application / API → Domain → PostgreSQL
                                → Runtime capability interfaces
                                    ▲
                    Deployment adapters implement them
```

PostgreSQL is a committed choice, not a pluggable one. Keep database access behind a clear `db` boundary, but do not wrap it in a generic repository or persistence port. Reserve interfaces for capabilities that actually vary by environment.

Core domain code must not depend on:

- Cloudflare bindings or other cloud-provider-specific APIs
- Docker-specific behavior
- deployment environment details
- billing or hosted-service concepts

Deployment adapters may depend on the core runtime; the core runtime must not depend on deployment adapters.

## Repository layout

```text
apps/       deployable applications
packages/   reusable packages with real dependency boundaries
deploy/     deployment-specific configuration
```

A package must represent a meaningful ownership or dependency boundary. Extract packages when implementation shows the boundary is real, not to make the repository appear modular.

## Domain model

The domain model represents quality and compliance concepts directly: organizations, users and memberships, documents, requirements, controls, evidence, risks, audits, findings, incidents, CAPAs, training, suppliers, approvals, and workflows.

Do not shape domain concepts around individual standards, deployment providers, or UI screens unless the concept genuinely requires it. Shared concepts have one source of truth.

## Tenancy

Tenant isolation is a system invariant.

Tenant-owned data must be explicitly associated with an organization or equivalent tenant boundary, and authorization must prevent cross-tenant access regardless of client behavior.

Never rely solely on UI filtering, route conventions, user-supplied tenant identifiers, or implicit application context as the tenant boundary.

Cross-tenant relationships must be impossible unless explicitly modeled and authorized.

## Authentication and authorization

Authentication establishes who is making a request. Authorization decides whether that actor may perform an action on a resource. Keep these concerns separate.

Enforce authorization server-side at the application or domain boundary, never only in the UI. Cover important authorization behavior with tests.

## Persistence

PostgreSQL is the primary transactional data store. Prefer its capabilities (transactions, constraints, row and advisory locks, `FOR UPDATE SKIP LOCKED`, JSON where appropriate) before introducing additional infrastructure.

Enforce important invariants with database constraints where practical. Application validation complements database integrity; it does not replace it.

## Migrations

Migrations are forward-only and part of the runtime's compatibility contract.

Once a migration may have been applied outside local development, do not edit it; add a new one.

Migrations must preserve data integrity, tenant isolation, upgradeability, and recovery feasibility where important.

## Transactions and concurrency

Use transactions for multi-record invariants.

Code that can run concurrently must account for duplicate execution, retries, idempotency, lost updates, and race conditions. Do not assume a request, job, or workflow runs only once.

## Auditability

Important state changes must be auditable: what changed, who or what changed it, when, which resource, and the previous and resulting state where relevant.

Audit history must not depend solely on mutable application logs.

## Versioning and controlled records

Controlled artifacts preserve history rather than overwrite it. Where historical state matters, prefer explicit versions and lifecycle transitions over in-place mutation.

Published, approved, signed, or otherwise finalized records must not silently change.

## Runtime capabilities

The core runtime may depend on narrow interfaces for environment-specific concerns such as object storage, background jobs, email, and AI providers.

Introduce such a boundary only for a real environmental difference the application must support, not for hypothetical providers.

## Background work

Start with PostgreSQL-backed coordination before introducing dedicated queue infrastructure.

A small deployment should be able to run HTTP and background work from the same application artifact, without a dedicated queue or separately operated worker service. Larger deployments may run them as separate processes from the same codebase.

Jobs must tolerate retries and duplicate execution.

## Storage

PostgreSQL is the source of truth for file metadata, relationships, and access-control state; durable storage owns the bytes. The application authorizes file access from PostgreSQL-backed state, never from storage location alone.

Persistent file storage must not rely on process memory or ephemeral local storage. Vendor-specific storage concepts stay outside domain logic.

## AI

AI may assist with understanding, generating, classifying, mapping, and operating quality workflows, but its output must not become an implicit source of truth for critical enforcement.

AI-driven changes must be inspectable, attributable, and auditable, and reviewable or testable where they affect deterministic behavior. Prefer `describe → generate → inspect diff → test → approve → deploy` over opaque autonomous mutation.

## Extensibility

Quality Runtime should be customizable without requiring permanent forks.

Introduce explicit composition or extension points only when concrete use cases require them. Keep them narrow and prefer ordinary APIs and data models over a general plugin framework.

Deployment-specific and private extensions add behavior without requiring changes to core domain logic.

## Deployment

The intended minimal self-hosted production deployment requires only:

```text
Quality Runtime + PostgreSQL + durable file storage (a mounted volume is enough)
```

Additional services must not become mandatory without strong operational justification.

Cloud-provider-specific implementations live in deployment adapters, and the application must remain portable to other environments.

## Hosted product boundary

The public runtime contains functionality generally useful to anyone operating Quality Runtime themselves. Hosted-service concerns (billing, subscriptions, provisioning, usage metering, entitlements, internal cloud operations) stay outside it.

The hosted product extends the runtime rather than redefines it.

## Architectural invariants

**ARCH-01 — Deployment independence**
Core domain logic must not depend on a deployment provider.

**TENANT-01 — Tenant isolation**
Tenant-owned data must not be accessible across tenant boundaries without an explicitly modeled and authorized relationship.

**AUTHZ-01 — Server-side authorization**
Security decisions must not depend solely on frontend behavior.

**DATA-01 — PostgreSQL authority**
PostgreSQL is the primary source of truth for transactional application state, including file metadata and access-control state.

**MIGRATION-01 — Immutable migration history**
Applied migrations must not be rewritten.

**AUDIT-01 — Important changes are auditable**
Material quality and compliance state changes must leave durable audit history.

Changes made by a domain mutation request are audited. What a _foreign key_ does is not: a cascade is a referential action, invisible to the application that triggered it, so removing a standard takes its requirements and removing an organization takes everything with no event for any of it. That is a known hole in this invariant rather than a reading of it — `docs/data-model.md` and [ADR 0010](docs/adr/0010-mapping-controls-to-requirements.md) name each place it bites.

**VERSION-01 — Historical state is preserved where required**
Controlled or finalized records must not silently lose historical state.

**EXT-01 — Extensions add rather than patch**
Customization prefers explicit composition points over modifications to core implementation.

## Changing the architecture

Evolve the architecture when concrete product or operational needs justify it. Before introducing a new service, abstraction, package, datastore, queue, or extension mechanism, ask:

1. Does a real current requirement need it?
2. Can PostgreSQL, the runtime, or an existing dependency already solve it?
3. Does it create another source of truth?
4. Does it make self-hosting harder?
5. Does it introduce deployment-provider coupling?
6. Will both humans and coding agents understand the resulting system more easily?

Prefer the simpler design when both approaches satisfy the requirement.
