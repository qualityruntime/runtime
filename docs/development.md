# Development

This document describes the local development workflow for Quality Runtime.

## Requirements

- Bun (the version pinned by `packageManager` in `package.json`)

The toolchain is [Vite+](https://viteplus.dev): dev server, build, tests, linting, and formatting behind the `vp` CLI, configured in `vite.config.ts`.

## Setup

Install dependencies:

```sh
bun install
```

Create the required local environment configuration from the provided example when one exists.

## Development

```sh
bun run check   # format, lint, and type checks
bun run fmt     # apply formatting
bun run lint    # lint only
```

Vite+ offers more (`vp dev`, `vp build`, `vp test`); those are documented here once the application scaffold uses them. Commands shown in this document work as written; do not assume undocumented ones exist.

## Database

PostgreSQL is the application database.

Schema changes add a new migration; see `AGENTS.md` for the rules that govern migration history. Test migrations against realistic existing data when the change is non-trivial. Database setup and migration commands are documented here once implemented.

## Before finishing

Run `bun run check`, plus the REUSE lint.

For REUSE validation on macOS:

```sh
uvx --from 'reuse[charset-normalizer]' reuse lint
```

Do not add tools, services, packages, or abstractions solely to satisfy a hypothetical future requirement.

For repository-wide engineering rules, see [`../AGENTS.md`](../AGENTS.md). For architectural constraints, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
