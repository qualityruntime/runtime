<!--
SPDX-FileCopyrightText: 2026 Quality Runtime contributors
SPDX-License-Identifier: Apache-2.0
-->

# 20. Testing races

## Status

Accepted.

## Context

The suite runs on PGlite, in process, needing nothing started — which is most of why it is pleasant to work with, and is written into [development](../development.md) as a feature.

PGlite is one connection. Two things cannot happen at once, so **no `SELECT … FOR UPDATE` in this codebase had ever been exercised**. Every claim about what a lock prevents was argued from PostgreSQL's documented lock conflicts rather than demonstrated, and several ADRs said so in as many words.

One of those claims was wrong. [ADR 0019](0019-conditional-writes.md) asserted that comparing an entity tag was atomic because the row was locked; on the evidence discard it was not, and the comparison ran against an unlocked read. An external reviewer found it in minutes by opening two sessions. Nothing in the suite could have.

## Decision

**One suite runs against a real PostgreSQL, and only it does.** `apps/server/concurrency.test.ts` is skipped unless `TEST_DATABASE_URL` names a database — so `bun run test` still needs nothing running, and the property that makes the rest of the suite pleasant is kept.

**Each test forces the interleaving rather than hoping for it.** A second session takes the row lock; the request is started and blocks on it; the second session makes its change and commits; the request is released into a world that moved under it. Timing is never relied on.

**A request that never blocked fails the test.** This is the part that matters, and the first version got it wrong. Starting a request only schedules it: without waiting for the request to actually block, the other session can finish before the handler has touched the database, and the two never overlap. Every test passed, and removing the locks they were written to exercise changed nothing. The suite now asks PostgreSQL who is waiting — `pg_stat_activity` where `wait_event_type = 'Lock'` — and gives up with an explicit failure if nobody is.

That check cannot filter by role, incidentally: the application switches role after connecting, so `usename` remains the login user. It filters on the database instead, which is sound because the only session deliberately holding a lock is not itself waiting on one.

**It runs as a role that owns nothing and bypasses nothing**, set per connection, so the policies are in force as they are in a deployment. A superuser connection would be exempt from row-level security, and several of these handlers depend on it — an attested row cannot be locked, which is why evidence reads unlisted before it locks.

**The database is wiped every run**, so the file refuses one whose name does not end in `_test`.

## Consequences

The locks are now load-bearing in a way that can be checked. Removing `FOR UPDATE` from the control amendment, the control discard or the evidence amendment each fails a test; so does reverting [ADR 0019](0019-conditional-writes.md)'s bug, and so does building an amendment's audit diff from the unlocked read rather than the locked one. Those were arguments; they are now tests.

**Forcing the order is part of the test.** A lock queue is first-come, so starting one request and waiting for it to join the queue before starting the other decides which wins. The first version of the attach-versus-discard test left that to chance and passed whenever the order happened to be the harmless one — which is the same false negative as not blocking at all, arriving later.

**It found a second defect immediately.** Without its lock, the control discard answered `204` having deleted nothing — the policy refused the row and the handler never looked. The lock makes that unreachable, but "unreachable" is what the previous bug was also believed to be, so the delete now checks that it matched something, as the evidence discard already did.

**It kept finding things.** A second round added the same foreign-key race one level down — attaching a file read its evidence unlocked and took the key share only at the insert, so a discard landing in between made it a `500`. Fixing that introduced a regression of its own, caught by review rather than by the suite: a locked read is governed by the `UPDATE` policy, which sees only unattested rows, so evidence attested mid-upload came back as "does not exist" rather than "already attested". The same trap this file warns about two paragraphs above, walked into while fixing something else.

And forcing a transaction to fail — by taking away the privilege its audit write needs — showed that `insufficient_privilege` was being read as "the evidence was attested in between" wherever it came from. It now checks the table too, so a privilege error elsewhere in the transaction is no longer answered with a confident wrong diagnosis.

**It found a third defect, in the race it was written to prove.** [ADR 0013](0013-durable-storage.md) argued that recording evidence and discarding its control cannot interleave, because the foreign key check takes `FOR KEY SHARE` and the discard holds `FOR UPDATE`. True as far as it went — but the recording read its control _without_ a lock and took the key share only at the insert, so a discard landing in between turned it into a foreign key violation and a `500`. It now takes that lock on the read and holds it, which makes the loser lose cleanly: `404` if the control went, `409 has_evidence` if the evidence did.

**Pooling is exercised for the first time.** PGlite is one connection, so a connection being _reused_ by a second tenant had never happened in a test — while tenant isolation rests entirely on a transaction-local setting on a pooled connection. Two tests cover it: interleaved requests from two organizations, and every connection in the pool checked out at once and asserted clean. Sampling one connection is not enough, and was the first version's mistake: a tenant left behind on any other connection went unseen.

Between transactions the setting is spent but not unset — PostgreSQL leaves it as the empty string. That is safe because no organization identifier equals it, which is the property the tests assert rather than the value.

**Where an empty locked read is ambiguous.** `SELECT … FOR UPDATE` is governed by the `UPDATE` policy, so a row that policy excludes is not there to lock — and neither is a row somebody deleted while this transaction waited. From the lock alone the two are indistinguishable, and reporting the wrong one is a confident wrong answer: "already attested" for a record that was discarded and never signed.

It is ambiguous **exactly where the policy governing the locking command restricts which rows exist**, which is three places: amending evidence, discarding evidence, and attaching a file — all three governed by `evidence_tenant_amend`, which sees only unattested rows. Each re-reads without the lock to tell the two apart. Everywhere else the governing policy is tenant-only, so an empty result genuinely means absent: the three locked reads of `control`, the key-share read of `requirement`, and the key-share read of `control` when evidence is recorded.

Discarding a control is sound for a different reason. Its `DELETE` policy _does_ restrict which rows exist, but the row is locked first, so a delete matching nothing can only mean the predicate refused it — never that somebody else got there.

**Not everything is covered.** Nothing yet covers connection exhaustion, a request cancelled mid-transaction, or two organizations contending for the same row — which cannot happen, since no row belongs to two.

**CI runs it.** The `check` job takes a `postgres:18` service and sets `TEST_DATABASE_URL`, so a change that breaks a lock fails there rather than for whoever runs the suite next. That the setup works from nothing — no schema, no role, no rows — is checked by running it against a database created for the purpose, which is CI's situation exactly.

**One PostgreSQL version, deliberately.** PGlite serves 18.3 in process and everything else runs 18: this suite, CI, and the setup `docs/development.md` prints. It briefly ran 17 here while a local install was, which is how the split was noticed — a difference between the two would have surfaced as one suite disagreeing with another for reasons unrelated to the change being made. Both are 18 now and the suites agree because they are testing the same thing.

**A second database is now part of a full local setup.** It is optional and documented in `.env.example`, and an unset variable skips silently — which is the point, and also the residual risk: a developer who never sets it sees a green suite that tested none of this. CI setting it is what stops that mattering. A variable that _is_ set but names a database this would refuse to wipe stops the run instead of skipping, because a skip there would be the same failure wearing a disguise.
