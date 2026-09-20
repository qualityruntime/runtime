# 16. Verifying stored bytes

Date: 2026-09-18

## Status

Accepted. Where this says "volume", read "bucket": [ADR 0021](0021-file-bytes-in-object-storage.md) moved the bytes to S3-compatible object storage, and this command was adapted rather than reconsidered. The two consequences that changed are corrected below.

## Context

[ADR 0013](0013-durable-storage.md) recorded a SHA-256 for every file and was candid that nothing checked it: _"nothing yet verifies it in the background, which is the obvious next thing."_

An unverified checksum is close to no checksum. The reason it is there at all is that a volume has no row-level security — every other guarantee here is one PostgreSQL enforces, and this is the one place where "the record cannot change" depends on something outside the database behaving. A recorded hash that nobody ever recomputes makes tampering _theoretically_ detectable and practically undetected.

## Decision

**A command, not a route.** `bun run verify:files` reads every file the deployment holds, recomputes the hash, and reports anything that no longer matches, is no longer there, or can no longer be read. It exits non-zero when it finds something, so a scheduled run does not need its output read to be useful.

**Every fault is a finding, including the ones that are exceptions.** A file that cannot be opened, or that is not a regular file at all, is reported rather than thrown. The adversary this exists for is whatever can write to the volume, and that adversary can make one file unreadable as easily as it can change another's bytes — a report that stops at the first fault, or hangs on a FIFO somebody dropped in, would hide exactly what it is for. The scheduled run notices nothing when the command produces no output.

Not a route because it reads every byte the deployment holds. That is not work to do inside a request, and an endpoint that invites it is an endpoint that invites doing it by accident.

**The work takes a database handle and a store, not a request.** `verifyOrganization(db, store, organizationId)` knows nothing about HTTP. `verify-files.ts` is the deployment-specific part that reads the environment and owns a connection, exactly as `bun.ts` does for the server.

This is the first thing here that does domain work outside a request, and `ARCHITECTURE.md` says that is what should force a domain layer to separate from the routes. It did not, and that is worth recording: what the handlers actually bind to Hono is finding the tenant and attributing a change, and both of those are already free functions in `packages/db` — `withOrganization` and `recordChange`. The seam exists; it is just not where the note assumed. A job that needed to _write_ domain records would test that harder.

**Each organization is verified inside its own tenant context.** `verifyEverything` lists organizations — `organization` is Better Auth's table and carries no policy — and then reads each one's files as that organization. A verifier that reached across tenants to read rows faster would be the one piece of code allowed to ignore the boundary, and there is no reason for it to be.

That property is a property of the role, so the command asserts it the way `bun.ts` does: a connection whose role bypasses row-level security reads every organization's rows inside each organization's context, which counts and reports every file once per organization. This command is the one most likely to be pointed at a different connection string — a replica, a backup host — by someone reasoning that it only reads.

**Findings are returned and printed, not recorded.** Whether a failed verification belongs in `audit_event` is a real question and the answer is not obviously yes: that table records changes an actor made, and this is an observation about something nobody here did. Recording it would stretch the model, and stretching it quietly is how a model stops meaning anything.

## Consequences

The cost of verification is the size of the volume, every time. It reads files one at a time on purpose — doing it as fast as the disk allows is no kindness to a server running beside it — and a deployment should schedule it rather than run it continuously. Nightly is a reasonable starting point, and it can run against a replica or alongside a backup.

Nothing keeps the findings. A run that reports a tampered file and is then lost tells nobody anything, so `docs/deployment.md` says to keep the output — which is exactly the "mutable application logs" that AUDIT-01 says audit must not depend on. That is the gap this leaves open, and it is open deliberately rather than by oversight: the right home for a finding is a decision, not a detail.

Verification cannot distinguish _tampering_ from _corruption_. A changed byte is a changed byte, whether a disk rotted or somebody edited a PDF. The report says what it knows — this file is not what was stored — and leaves the conclusion to whoever reads it.

It also cannot, by itself, distinguish a store whose files are gone from a store it is not actually pointed at: the wrong bucket answers "no bytes" for every key. So the command refuses to start when the bucket does not answer, and the report says so when every file it checked was missing, rather than sending someone to the backups over a typo.

The sweep for the other direction — bytes in the store that no row claims — needed the store to list its keys, which `FileStore` deliberately did not do. Under [ADR 0021](0021-file-bytes-in-object-storage.md) a bucket can, and `bun run reclaim:storage` is that sweep. It is a second command rather than part of this one because the two answer different questions and carry different risk: this one reads and reports, and that one can delete.
