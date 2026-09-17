# Quality Runtime

**The open-source runtime for quality and compliance.**

Quality Runtime is an AI-native platform for building and operating quality and compliance systems.

It is designed to be easy to self-host, understand, customize, and extend — whether the work is performed by people, software, or AI agents.

> **Status: early development**
>
> Quality Runtime is under active development and is **not yet ready for production use or deployment**. APIs, schemas, architecture, and repository structure may change significantly.

## Why Quality Runtime

Quality and compliance software should be operational, programmable, and adaptable.

Quality Runtime aims to make standards, controls, procedures, evidence, audits, risks, incidents, CAPAs, training, suppliers, approvals, and related workflows part of a coherent system that both humans and AI can understand and operate.

The project is built around a few principles:

- **Open source and self-hostable** — the core product should be genuinely useful without a hosted service.
- **AI-native** — AI should be able to understand and act across the system through clear models, APIs, and tools.
- **Deterministic where it matters** — critical enforcement should remain explicit, testable, and auditable.
- **Composable** — customization should happen through stable models, workflows, APIs, SDKs, and extensions rather than permanent forks.
- **Understandable** — prefer simple architecture and boring primitives over unnecessary infrastructure and abstraction.
- **Auditable by design** — important changes should be attributable, reviewable, versioned, and traceable.

A long-term customization workflow should feel like:

```text
describe → generate → inspect diff → test → approve → deploy
```

## Architecture

Quality Runtime is being built primarily with:

- TypeScript
- Bun
- PostgreSQL
- React
- Vite+
- Hono
- shadcn/ui
- Better Auth

PostgreSQL is the primary source of truth, and the core application is designed to remain independent of any specific deployment provider.

Docker will be the canonical self-hosted deployment target. Other environments, including Cloudflare Workers, may be supported without becoming dependencies of the core runtime.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the architectural principles and system boundaries.

## Development

The project is currently being built in public.

Development setup is documented in [docs/development.md](./docs/development.md). Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting changes.

If you are exploring the codebase, also read:

- [AGENTS.md](./AGENTS.md) — repository rules for humans and coding agents
- [ARCHITECTURE.md](./ARCHITECTURE.md) — architecture and system invariants

## Hosted service

A managed version of Quality Runtime is planned at [qualityruntime.com](https://qualityruntime.com).

The open-source runtime will remain independently self-hostable. The hosted service will focus on managed operation, infrastructure, AI, integrations, enterprise capabilities, and support.

## License

Quality Runtime is licensed under the [Apache License 2.0](./LICENSE).

---

[qualityruntime.com](https://qualityruntime.com) · [GitHub](https://github.com/qualityruntime)
