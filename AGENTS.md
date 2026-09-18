# Quality Runtime

## Principles

- Prefer simple, direct implementations over abstractions.
- PostgreSQL is the primary source of truth.
- Avoid introducing new infrastructure unless clearly necessary.
- Prefer existing platform and library capabilities over custom machinery.

## Documentation

Each document has a canonical responsibility. Prefer extending the document that already owns a topic; add a new one only for a distinct, durable responsibility.

| Document              | Owns                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `README.md`           | What the project is, for newcomers                                   |
| `AGENTS.md`           | Rules for changing this repository                                   |
| `CONTRIBUTING.md`     | How to contribute changes                                            |
| `ARCHITECTURE.md`     | System constraints and invariants                                    |
| `docs/product.md`     | Why the product exists; product principles                           |
| `docs/data-model.md`  | Domain entities, relationships, lifecycle, ownership, and invariants |
| `docs/security.md`    | Security model and trust boundaries                                  |
| `docs/development.md` | Building, running, and testing locally                               |
| `docs/deployment.md`  | Installing, configuring, and upgrading                               |
| `docs/adr/`           | Individual decisions, once made                                      |
| `.github/SECURITY.md` | Vulnerability reporting policy                                       |

## Architecture

Read `ARCHITECTURE.md` before making structural changes.

Deployment adapters may depend on core code; core code must not depend on deployment adapters or provider-specific concerns such as Cloudflare.

Apps go in `apps/`, shared code in `packages/` — extract a package only when the boundary is real.

## Changes

- Make the smallest coherent change that solves the problem.
- Delete unnecessary code instead of extending weak abstractions.
- Do not add speculative extension points.
- Add or update tests for important behavior.
- Never weaken tenant isolation, authorization, auditability, or data integrity for convenience.
- Never modify an existing applied database migration; add a new one.
- Sign off commits with `git commit -s` (Developer Certificate of Origin); pull requests opened by `qualityruntime[bot]` are exempt.

## Licensing

The project is Apache-2.0 and [REUSE](https://reuse.software)-compliant. Start every new source file (code, SQL, scripts, config that supports comments) with a two-line SPDX header in the file's comment syntax. First-party files use:

<!-- REUSE-IgnoreStart -->

```ts
// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0
```

<!-- REUSE-IgnoreEnd -->

- Name the actual copyright holder of the work: never remove or rewrite existing notices, and give a file its own annotation or `.license` sidecar when the holder differs from the `REUSE.toml` default.
- Place the header after a shebang if one is present.
- Markdown, JSON, lockfiles, and `.gitignore` are covered by `REUSE.toml`.
- License other non-commentable files (e.g. images) deliberately, with a narrow `REUSE.toml` annotation or a `.license` sidecar. Never broaden the default annotation just to make the lint pass.

## Product boundary

Generally useful Quality Runtime functionality belongs in this repository.

Hosted-service concerns such as billing, metering, customer provisioning, and internal cloud operations do not.

## Before finishing

Run `bun run check` (Vite+ format, lint, and type checks), `bun run test`, and `uvx --from 'reuse[charset-normalizer]' reuse lint`.
