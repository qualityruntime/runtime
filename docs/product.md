# Product

Why Quality Runtime exists: mission, users, product principles, what it is and is not, and the open-source, AI, and hosted-product philosophy.

## Why it exists

Organizations that must demonstrate conformity — to a standard, a regulator, a customer's security review — mostly do it with documents. A spreadsheet of controls, a folder of screenshots, a policy nobody has read since it was approved, and a fortnight of work before every audit reassembling the story of what actually happened.

The information exists. It is just not a system. Nothing can answer _which requirements has nobody taken up_, or _what evidence supports this control_, or _who attested this and when_, without a person going and looking.

Quality Runtime exists to make that a system: one where the relationships are real, the history is kept, and the questions can be asked by a program rather than a person. Not a place to file documents — a runtime that knows what is required, what is being done about it, and what evidence there is.

The shape of the thing is a loop:

```text
requirement → control → evidence
```

A requirement is what a standard asks for. A control is what the organization does about it. Evidence is what shows the control was operated. Everything else this product may grow — audits, risks, findings, CAPAs, training, suppliers — hangs off that loop or is a variation of it.

## Who it is for

**The person accountable for conformity** — a quality manager, a compliance lead, whoever has to say "yes, we do that, and here is why you should believe me". They need to see what is covered and what is not, and to produce a defensible record without assembling it by hand.

**The people who actually operate the controls** — engineers, administrators, anyone who performs the review or runs the restore test. For them the product must be quick and out of the way, or the evidence stops arriving.

**Auditors and reviewers**, who need to follow a claim back to the thing that supports it, and to know that what they are reading has not been quietly changed since it was attested.

**Programs.** Scripts, integrations, and AI agents are first-class users, not an afterthought: most evidence is produced by systems, and a product that can only be operated by a person in a browser will always be behind.

## Product principles

These are not aspirations. Each one is already a decision somewhere in `docs/adr/`, and the reasoning lives there.

**Enforce it where it cannot be forgotten.** Tenant isolation, an append-only audit log and the finality of an attested record are enforced by PostgreSQL, not by application code that has to remember. Application code is where mistakes live; a policy is where a guarantee lives.

**Record what happened rather than overwrite it.** History is not a feature. A control that was in effect and is now retired, and an attestation made by a person who has since left, are both part of the record — so retiring is what deletion usually means, and attribution survives the actor.

**Say what you know, and not more.** A control mapped to a requirement means somebody _intends_ it to address that requirement. It does not mean the requirement is met, and the product does not let that word creep in. A compliance score computed from mappings would be a number that means nothing, arrived at confidently.

**Model small, and add when something needs it.** Every entity here is narrower than a quality system eventually wants: no owner on a control, no rationale on a mapping, no validity period on evidence. A field added when a workflow needs it is cheaper than one that turned out to mean the wrong thing. The absences are deliberate and written down.

**Make self-hosting boring.** PostgreSQL, and nothing else mandatory: no queue, no object store, no search cluster, no second service to operate. Anything that would become mandatory has to earn it.

**Be readable by a program.** The API describes itself, the identifiers say what they are, the errors carry codes, and the collections page the same way. An AI agent should be able to work the product from its own description, without a human explaining the conventions first.

**Say what is not true yet.** The documents here record gaps as plainly as features — what is unaudited, what is last-writer-wins, what nobody has verified. A product that hides its edges is one nobody can safely build on.

## What it is not

**Not a document management system.** Controlled documents — revisions, approvals, effective dates, supersession — are a deep subsystem and a familiar one, and building it first would have delayed the loop that actually distinguishes this product. It is postponed deliberately, not forgotten.

**Not a compliance score.** Nothing here computes a percentage of conformity. The product answers concrete questions — which clauses nobody has taken up, what evidence supports this control — and leaves the judgement to the person whose name goes on it.

**Not a checklist that certifies anything.** Using Quality Runtime does not make an organization conformant, and no output of it is an audit opinion. It keeps the record; people and auditors decide what the record means.

**Not a hosted-only product.** The open-source runtime is the product, not a demonstration of it.

## AI

AI is expected to read, write, map, draft and operate through the same API everything else uses. Requests currently record the authenticated user as the actor; the `system` actor type is reserved for background work and has no writer yet. It does not identify programs using a person's session.

What AI may not do is become an implicit source of truth. Anything it produces is inspectable and attributable, and nothing it generates bypasses the enforcement everything else is subject to: a control drafted by a model is a draft, and becomes active only through the same deliberate transition anything else makes, recorded with who made it.

Nothing yet _requires_ a person for that transition — the lifecycle makes it deliberate and the audit record makes it attributable, but no rule says an agent may not put a control into effect. Whether some acts should require a human is a real question, and `member.role` exists but does not gate domain API actions today.

What it cannot currently tell is a program holding a person's credentials from that person. There are no machine credentials distinct from a human session, so anything with the cookie is that human as far as the system knows. For a record whose whole value is that somebody vouched, that is a gap worth naming.

## The open-source boundary

Everything generally useful to anyone operating Quality Runtime themselves belongs in this repository, and it should be genuinely useful with no hosted service involved.

A managed service is planned, and what belongs to it is the operation rather than the product: billing, metering, provisioning, entitlements, internal cloud operations. It extends the runtime; it does not redefine it, and it does not hold back capability the self-hosted product needs.

## Status

The schema for the whole loop is in place, and PostgreSQL enforces its tenancy and finality: standards, requirements, controls, mappings, evidence, attestation and files. The API serves the first part of it: controls can be created, changed, moved through their lifecycle and — while they never took effect — discarded, and every change is audited and readable as history. Standards, mappings, evidence and files are not yet reachable through the API.

There is no user interface, no deployment artifact, and none of the entities beyond that loop.

`README.md` states the maturity honestly. Nothing here is stable: the API, the schema and the shape of the model may all still change, and the documents in `docs/adr/` record why each is what it is so that changing one is a decision rather than a guess.
