# 13. Durable storage, and the file that goes with evidence

Date: 2026-09-18

## Status

Accepted

## Context

[ADR 0012](0012-evidence-and-attestation.md) built evidence without its file and said why: storing bytes means a runtime capability and a deployment adapter behind it, and that would have swallowed the questions about attestation.

This is that half. It is the first time the core has needed something the environment provides rather than something PostgreSQL does, so it also decides what such a thing looks like.

## Decision

**A narrow interface, implemented by a deployment adapter.** `FileStore` has three methods — `put`, `get`, `discard` — and no concept of a tenant, a file name, or a permission. The core depends on the interface and never on an implementation (ARCH-01), and `bun.ts` chooses the implementation the way it chooses a connection pool.

`discard` is for cleaning up after a write whose row never landed, not for deleting a file someone can see. What may be removed is decided in PostgreSQL.

**PostgreSQL is the authority; storage holds bytes under a key.** The `file` table says what a file is, whose it is, and who may read it. Storage is asked for bytes under a key it was given, and knowing a key is not permission to read it — `GET /files/{id}` resolves the row inside the tenant context first, and a file belonging to another organization is a 404 exactly as one that does not exist (DATA-01).

The key is the row's own identifier, so it is never supplied by a caller. The adapter validates it against the shape `packages/db` generates anyway, because a key becomes a path and nothing else may be one.

**The body is the file.** `POST /evidence/{id}/files?filename=…` sends the bytes as the request body rather than as a multipart part. Multipart would mean parsing a format to recover a single value, and every parser buffers; this streams to storage as it arrives. The name goes in the query because the body is spoken for.

**A limit is what you count, not what you were told.** `Content-Length` is checked first so an obviously oversized upload is refused before a byte is read, but the real bound is enforced while writing — 25 MiB, counted by the store, which throws and leaves nothing behind. The upload route is therefore the one path under `/api/v1` that the shared body limiter does not touch: a limiter with nothing to go on buffers the stream to find out how big it is, which is precisely what streaming avoids ([ADR 0009](0009-importing-a-standard.md) records why the limit is chosen centrally at all).

**The bytes are written before the row, and the row is the decision.** There is no transaction spanning a filesystem and a database. Writing bytes first means a failure leaves bytes nothing points at, which is harmless and cleanable; writing the row first would mean a row pointing at bytes that are not there, which is a broken file. When the row does not land — the evidence is attested, or is not there, or already carries as many files as it may — the bytes are discarded straight away. Written has to mean durable: the disk store syncs the file and every directory up to the storage root before it returns, so a crash after the row commits cannot leave it naming bytes that were only in a cache.

**A checksum, because storage has no row-level security to lean on.** Every guarantee elsewhere here is one PostgreSQL enforces. A volume has no policies: whatever can write to it can change what an attested record's file says. The SHA-256 is counted while writing and kept on the row, so that a change to the bytes is detectable rather than silent. It is not verified on read — that would be a full extra pass on every download. It is verified on demand: `bun run verify:files` walks every file _row_ a deployment holds, recomputes the hash, and reports anything that no longer matches, is no longer there, or can no longer be read ([ADR 0016](0016-verifying-stored-bytes.md)). Bytes with no row are invisible to it, by the same token.

**A file follows its evidence.** Nothing may be attached to attested evidence, and nothing is ever detached: a file goes only when its unattested evidence is discarded, by cascade. A record whose attachments can still change is not final, so [ADR 0012](0012-evidence-and-attestation.md)'s rule would be hollow without this. `file` has no `UPDATE` or `DELETE` policy — a file row describes bytes that are already written, and there is nothing about it to amend.

**Attaching is decided by a trigger, not a policy.** The first version asked in the `INSERT` policy whether the evidence was attested, and a policy is a test rather than a lock: under `read committed` its subquery reads a snapshot taken before a concurrent attestation committed, and the `FOR KEY SHARE` a foreign key takes does not conflict with the attestation's `UPDATE`, so an attachment sailed straight past a signature landing beside it. The handler closed that by locking the evidence first — correct, and a rule every future insert path would have had to remember. `file_evidence_open` now takes `FOR NO KEY UPDATE` on the evidence for every insert and refuses one that is attested, so the guarantee is PostgreSQL's; `apps/server/concurrency.test.ts` inserts with no lock of its own and is refused ([ADR 0020](0020-testing-races.md)). The handler still takes the same lock earlier, to answer 404 or 409 rather than a 500 and to hold its count.

**A file is never offered for a browser to render.** Downloads carry `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, and the filename in that header is reduced to printable ASCII. A tenant chooses the bytes and the content type; this origin does not run them, and a quote or a newline in a filename is a way to write a header of your own.

The content type is the other half of that, and the sharper one: it goes into a header verbatim, and a value the runtime will not put in a header at all makes the file permanently unreadable, since there is no `UPDATE` policy to repair the row with and an attested record will not give the row up. So it is constrained to `type/subtype` by `file_content_type_shape` as well as by the API — parameters are not accepted, because nothing downstream of `attachment` and `nosniff` would ever interpret one.

## Consequences

The minimal deployment is PostgreSQL and a directory, as `ARCHITECTURE.md` promised. `STORAGE_DIRECTORY` is now required, and the server refuses to start without it, like every other setting it cannot invent.

The interface would fit object storage, but the _upload shape_ is what a volume wants. S3 and its like prefer a signed URL the client uploads to directly, which the core cannot offer while it insists on counting the bytes itself. An adapter for one would either proxy the upload — correct, and it gives up the advantage — or the interface would gain a way to say "redirect the client here", which changes the route as well. That is a real decision and it belongs to whoever needs the second adapter.

No route removes a file _on its own_, but discarding its evidence does: the `file` rows cascade and the bytes stay, because a foreign key cannot reach a filesystem. So ordinary successful requests produce orphans, not only failed uploads — which clean up after themselves — and not only an operator removing a tenant. Deleting the organization still cascades through `file`, and that is now an operator's act with a credential the server does not have ([ADR 0014](0014-the-runtime-role-owns-nothing.md)). Whenever a row goes that way the bytes stay behind: a foreign key cascade cannot reach a filesystem. A sweeper comparing storage against rows is the answer, and it does not exist — so `verify:files` reporting nothing does not mean the volume holds nothing extra.

Evidence carries at most twenty files, which is what makes listing them with the evidence affordable rather than a route of its own. It is a limit chosen to make a shape work, which is a reason to revisit it if the shape stops fitting.

The count is the handler's, not a constraint, which would ordinarily make it a race — two uploads counting the same room and both taking it. It holds anyway, because the lock the handler takes before counting — the trigger's lock, taken early — excludes another attachment too. That is a consequence of a lock chosen for something else rather than a decision, so it is tested: twenty-two uploads fired together are accepted exactly twenty times.

The 25 MiB bound is a guess. It is generous for the minutes, screenshots and exports that evidence is actually made of, and small enough that a request cannot occupy a volume. Nothing about the design breaks if it changes.
