# Contributing

Thanks for contributing to Quality Runtime.

Before making a significant change, read:

- [`AGENTS.md`](./AGENTS.md)
- [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/development.md`](./docs/development.md)

## Principles

Prefer changes that are:

- small and coherent;
- easy to understand and maintain;
- backed by tests where behavior matters;
- consistent with existing architecture and product concepts;
- free of speculative abstractions and unnecessary infrastructure.

If a simpler implementation satisfies the requirement, prefer it.

## Pull requests

Keep pull requests focused on one logical change.

Include:

- what changed;
- why it changed;
- any important design or compatibility implications;
- relevant tests or verification.

Do not mix unrelated refactors with functional changes unless they are required for the implementation.

Significant architectural decisions should be documented as ADRs under `docs/adr/`.

## Security

Do not report security vulnerabilities through public issues.

See [`.github/SECURITY.md`](./.github/SECURITY.md) for private reporting instructions.

## Contribution provenance

Sign off every commit with `git commit -s`, which appends:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

The sign-off certifies your contribution under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). CI rejects pull requests whose commits are not signed off.

Pull requests opened by Quality Runtime's trusted project automation, `qualityruntime[bot]`, are exempt: a bot cannot make the DCO's first-person certification. The exemption covers automation acting for the project, not an external contribution rewritten by it — when automation submits someone else's work, that person's sign-off stays in the contribution.

AI-assisted contributions are welcome. The sign-off certifies the contribution under DCO 1.1 whether or not a coding agent assisted: review what you submit, make sure you can make that certification, and make sure you have the right to submit the work under Apache-2.0. It does not mean you typed every line. Do not submit code copied from third-party sources unless its license permits inclusion and you preserve the required attribution and notices.

## Licensing

Contributions are accepted under the Apache License 2.0.

The repository follows REUSE conventions. Follow the licensing instructions in [`AGENTS.md`](./AGENTS.md) and run the REUSE check documented there before submitting changes.
