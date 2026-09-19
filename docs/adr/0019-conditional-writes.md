<!--
SPDX-FileCopyrightText: 2026 Quality Runtime contributors
SPDX-License-Identifier: Apache-2.0
-->

# 19. Conditional writes

## Status

Accepted. Generalises the `If-Match` introduced for attestation in [ADR 0012](0012-evidence-and-attestation.md).

## Context

Attesting evidence required `If-Match` from the start, because a signature has to be of something in particular: without it a client can attest content it never saw, amended by somebody else between the read and the signature.

Every other mutation was last-writer-wins, and **the loser never found out**. Two people open the same control, both edit the name, the second write silently discards the first. [ADR 0017](0017-discarding-a-draft-control.md) then made discarding possible, which is the same race with a worse ending: a draft one member is reading can be thrown away by another while they read it.

The machinery to prevent that already existed — a row version, an entity tag, a comparison — in one route.

## Decision

**`If-Match` is honoured on every mutation of a record, and required on none of them except attestation.**

`PATCH` and `DELETE` for both controls and evidence compare the tag when one is given and answer `412` when it no longer matches. A request that sends no tag behaves exactly as before.

**Optional, deliberately.** Requiring it everywhere would make every write a two-request dance and break the simplest useful client — `curl` renaming a control — for a guarantee that client did not ask for. HTTP already has the shape for this: a conditional request is the caller's choice, and the server's job is to honour it exactly when it is made. Attestation is the exception because there the guarantee _is_ the feature.

**The version is `xmin`.** It identifies the transaction that wrote the row version. Separate transactions receive different values until transaction IDs wrap; repeated updates within one transaction share a value. `updated_at` would not do: it is set from JavaScript, so it carries milliseconds, and two writes inside one millisecond would share a value — a stale tag that still matched. `xmin` is not durable across a dump and restore, which makes outstanding tags stale; that is the safe direction, since a write is refused and the caller reads again. Freezing does _not_ do that, despite the folklore: PostgreSQL marks a frozen tuple with a flag and leaves the `xmin` it reports alone, which a probe confirms across a `VACUUM FREEZE`.

**For amendments and deletions, the comparison happens after the row is locked.** These handlers take `SELECT … FOR UPDATE` before comparing, so nothing can move between the test and the write and the version does not need repeating in the `WHERE`. Attestation instead constrains its `UPDATE` by the version, as described below.

Comparing against an unlocked read and then deleting allows a concurrent amendment between the two statements, deleting evidence the caller had not seen. The lock must span the comparison and deletion.

Evidence reads unlocked _first_, then locks, because `SELECT … FOR UPDATE` is governed by the `UPDATE` policy: an attested row is not there to lock, and "cannot be locked" would come back as "does not exist" rather than "cannot be changed". The unlocked read is what tells 404 from 409; the lock is what decides. Attestation repeats the version in its `UPDATE` predicate instead of taking an explicit lock before the comparison.

**`*` means only if it still exists**, and only as the whole field — never one item of a list, which RFC 9110 does not allow and which would otherwise turn a list into an unconditional write.

**Attesting does not use this parser at all**, and that is deliberate. It compares the header to the tag exactly, so `*` and a list are both refused even when the list holds the right tag. Everywhere else `If-Match` asks "has this moved?", and a wildcard meaning "only if it still exists" is a reasonable thing to ask. A signature is of something in particular, and "whatever version is there" is not a thing to sign.

The field is parsed rather than split. An entity tag is opaque and quoted, so a comma or an asterisk between the quotes is part of it: `"old,*,other"` is one tag that matches nothing, and splitting on commas exposes an `*` that was never a wildcard. Comparison is strong — a weak tag never matches, and nothing here issues one — and anything that is not a well-formed field fails, including a header that is present and empty. A client that sent the header meant something by it, and writing anyway is the wrong way to be wrong.

**A tag covers the whole representation, not just its row.** Evidence reads back with its files, so attaching one changes the record — and `file` is a separate table, whose insert does not move `evidence`'s version. Without something to say otherwise, a caller could discard evidence carrying an attachment it never saw, and the file would cascade away with it. Attaching therefore touches the evidence row, which the audit event already called an update to the evidence; now the row agrees.

**Preconditions are evaluated last.** A refusal that would have happened anyway — an illegal transition, a control that has been in effect, one carrying evidence, attested evidence — is answered before the tag is looked at. RFC 9110 §13.2.1 asks for that, and there is a second reason: checking the tag first makes a request that was going to be refused disclose whether the caller's tag matched.

**ETags are served where a client would get one**: reading a control, reading evidence, and the `PATCH` response of each, so a client can make a second edit without reading again. The published document declares the header on each of those responses — one that asks for `If-Match` and never says where the tag comes from describes half a contract.

## Consequences

`PUT /controls/{controlId}/requirements` was initially excluded because it replaces a set of mapping rows rather than amending one record, so there is no single `xmin` to quote. It now supports conditional writes using the **contents as the version**: SHA-256 of the sorted, deduplicated member identifiers encoded as a JSON array. JSON keeps member boundaries unambiguous and distinguishes an empty set from a set containing an empty string.

That tag says nothing about _when_. Two equal sets are indistinguishable, which is exactly what a caller asking "is it still what I read?" means.

**A control therefore has two tags**, and they are not interchangeable: its own row version, and its requirements' set version. Each is served by the route that owns it, and quoting one at the other's route is a mismatch and answers 412 — which is the right answer, since it names a version that resource does not have.

**The listing reads its page and its version from one snapshot.** Under `read committed` those are two statements and can see two different committed sets, which would hand a client a version for membership it was never shown. `withOrganization` takes a `repeatableRead` option for reads whose answers have to agree with each other. Reading one piece of evidence and listing a control's evidence use it too, for the same reason: a row and its separately queried attachments are two statements, and the tag an attestation quotes has to describe the files shown beside it. No write uses it — a write deciding from what is stored _now_ wants the opposite.

For row tags, the version is selected alongside the columns, so one query serves both the body and the tag; `withoutVersion` strips it before the response. Tests check representative responses against the strict published schemas ([ADR 0007](0007-openapi-from-the-schemas.md)); handlers do not validate outgoing responses at runtime.

Nothing obliges a client to use this, so nothing guarantees a careless one is safe. That is the cost of optional, taken knowingly: the product now offers the guarantee rather than enforcing it, and a client that wants to be careful can be.

`xmin` is a 32-bit counter and wraps. Two rows can therefore present the same tag, which does not matter — a tag is only ever compared against the row it was read from. What would matter is a row's `xmin` returning to a value a client still holds, which needs the counter to wrap between the read and the write; a stale tag matching wrongly is then possible in theory and not worth engineering against here.
