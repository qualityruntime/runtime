# 12. Evidence, and what attesting it settles

Date: 2026-09-18

## Status

Accepted

## Context

A control answering to a requirement asserts an intention. Evidence is what makes the assertion checkable: a record that the control was actually operated — a review performed, a restore tested, training completed — with a date and someone prepared to vouch for it.

It is also the first record here that anyone signs. `ARCHITECTURE.md` has said since the beginning that published, approved or signed records must not silently change (VERSION-01), and until now nothing in the schema was one; mutability was a shrug with a note in `docs/data-model.md`. Evidence is where that stops.

The file is the other half of evidence and is deliberately not in this decision. Storing bytes means a runtime capability and a deployment adapter behind it — the first this repository has needed — and it would have swallowed the two questions below.

## Decision

**Evidence belongs to a control**, by the composite foreign key every tenant-owned child uses ([ADR 0008](0008-standards-and-requirements.md)), and is read by its own identifier the way a requirement is ([ADR 0011](0011-reading-a-mapping-from-both-ends.md)).

**`occurredAt` is when the thing happened**, not when the row was written. Evidence of a review done last quarter is evidence about last quarter, whenever somebody got round to recording it, and a control's evidence is listed in that order. It is required — undated evidence evidences very little — and it may not be in the future, with a few minutes' tolerance for a client's clock. Nothing that has not happened is evidence that it did, and once attested there is no correcting it. A date before the control existed is allowed: recording work done earlier is ordinary.

**Attesting is a separate act with a route of its own**, `PUT /evidence/{id}/attestation`, and it is refused while impersonating. An administrator acting as a member may do that member's work; vouching is not work, it is a signature, and signing as somebody else is forgery however carefully it is logged. The attester is the resolved actor rather than `session.user`, which under impersonation is the person being acted as.

Attesting requires `If-Match`, quoting the `ETag` the evidence was read with. A signature is a signature on _something_, and without a precondition one person can read a draft, another amend it, and the first sign what they never saw. The tag is the row's `xmin` — the transaction that last wrote it — because `updated_at` is set from JavaScript and carries only milliseconds, so two amendments inside one millisecond would share a tag that still matched. The version goes into the `UPDATE`'s `WHERE` as well, so checking and signing are one statement.

It records who vouched and when — by identifier and by the name as it stood, because a record of who vouched for something is worth nothing if it disappears with them, the same reasoning audit history uses ([ADR 0005](0005-audit-history.md)). It is one act rather than a repeatable one: attesting twice is 409, not a second attestation with a later timestamp.

**An attested record cannot be changed, and PostgreSQL is what says so.** A tenant-owned table normally has one policy covering every command. Evidence names them, because what a tenant may do to a row depends on the row — as `control` later came to as well ([ADR 0017](0017-discarding-a-draft-control.md)):

```sql
CREATE POLICY "evidence_tenant_amend" ON "evidence" FOR UPDATE
  USING (organization matches AND "attested_at" IS NULL)
  WITH CHECK (organization matches);
```

`USING` decides which rows an `UPDATE` can see, and it sees only drafts. Attesting is therefore allowed — the row it starts from has no attestation — and every later change is not: an attested row is invisible to `UPDATE`, whatever the application asks. `DELETE` is the same. This is VERSION-01 as an enforcement rather than a convention, and it is the same shape as the append-only audit log.

A CHECK keeps an attestation whole: a time with nobody behind it is not an attestation, and a name with no time is not one either.

**A validity period is not modelled, and that is a decision rather than an omission.** Evidence goes stale — a review done last year is not evidence that a control is operating now — but staleness is a relationship between a control's expectations and an evidence date, not a property of the evidence. Putting `valid_until` on the evidence would have each record assert its own expiry, so two pieces of evidence for the same control could disagree about how often it needs doing. The cadence belongs to the control. It is not there yet because the question that would use it — _what is overdue?_ — does not exist either, and inventing a cadence format before anything reads one is how you get the wrong one.

## Consequences

**`SELECT … FOR UPDATE` is governed by the UPDATE policy, not only the SELECT one.** This is worth writing down because it was a surprise: locking a row requires being able to update it, so an attested row cannot be locked, and a handler that read it with `FOR UPDATE` first found nothing and answered 404 where 409 was meant.

So both handlers read unlocked to decide between 404 and 409, and only then lock. A lock that finds nothing does _not_ simply mean it was attested in between: the row may have been discarded while this transaction waited, and the two are indistinguishable from the lock alone. Answering "already attested" for a record that was thrown away and never signed is a confident wrong answer, so both handlers read again without the lock to tell them apart ([ADR 0020](0020-testing-races.md)). Attesting locks nothing at all — it reads unlocked and constrains its `UPDATE` by the version instead, for the reason given just above. Amending needs that lock for a reason that is easy to miss: without it two amendments can read the same values, and the second records no audit event because what it wrote matches what it _read_ rather than what was there. The preimage has to belong to the update that used it.

**An attested record can still be removed by a cascade, and only one such path is left.** Row security does not govern a foreign key's referential action — the same gap recorded for mappings in [ADR 0010](0010-mapping-controls-to-requirements.md). Two routes into it have since been closed: `evidence`'s foreign key to `control` restricts rather than cascades, so removing a control no longer takes its evidence ([ADR 0014](0014-the-runtime-role-owns-nothing.md)), and Better Auth's `POST /api/auth/organization/delete` is disabled. What remains is deleting the `organization` row itself, which cascades through everything and is an operator's act with a credential the server does not hold.

That is the right behaviour for a tenant leaving, and it is worth saying plainly rather than implying finality is absolute: **evidence is final against the application, not against the removal of the organization it belongs to.** A deployment that must keep attested records beyond the life of a tenant needs them exported or held elsewhere, and nothing here does that.

There is no way to withdraw an attestation. Unattested evidence can be discarded — the `DELETE` policy below has always admitted it, and [ADR 0017](0017-discarding-a-draft-control.md) gave it the route it lacked — but attesting something in error is corrected by recording new evidence, not by removing the old. That is the point of the rule, and it is also untested ground: nothing yet marks one piece of evidence as superseding another.

Evidence is attached to a control, not to a requirement. _What evidence is there for this requirement?_ is answered by going through the control's mappings, and was the next thing worth asking: evidence for a technical file is gathered per requirement, and a client doing it alone reads every mapped control's evidence, one request each and each at a different moment.

`GET /requirements/{id}/evidence` answers it — the evidence of the controls _currently_ mapped to the requirement, newest occurred first, drafts and attested alike, from controls in any state, with attachments, read in one snapshot per page. It is a view, not a record: unmapping a control takes its evidence out of the list and leaves the evidence as it was, and evidence attested before a mapping existed is listed all the same, because the attestation endorses the evidence rather than the mapping. It is not coverage. Evidence under a requirement says a mapped control was operated, not that the requirement is met, and a draft says less than that.

A page is a snapshot; a walk across pages is not, like every collection here ([ADR 0011](0011-reading-a-mapping-from-both-ends.md)), so this is not yet the export a technical file needs. `limit` bounds the rows, not the work: the order spans several controls, and no index supplies it directly, so a requirement with many heavily evidenced controls may have all of their evidence read and sorted to answer one page. Worth measuring before assuming it is cheap.

An attestation endorses the evidence row, not the state of anything around it. Retiring the control afterwards, or unmapping the requirement it answered to, leaves the attestation exactly as it was and says nothing about it — which is right, because the attester vouched for what the evidence says, not for the shape of the system a year later. Reading an old attestation as a claim about present coverage is a mistake, and nothing yet stops a reader making it.

Nothing checks that the attester is a different person from the recorder, or that they hold any particular role. Segregation of duties is a real requirement in this domain and a real decision, and `member.role` exists and gates nothing yet.
