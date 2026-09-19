# 8. Standards and requirements

Date: 2026-09-18

## Status

Accepted

## Context

`control` exists and has nothing to be _for_. A control is a measure an organization operates to meet a requirement, and until requirements exist the product is a list of measures answering to nothing. `requirement → control → evidence` is the loop that makes this a quality runtime rather than a CRUD application, and this is its first half.

Standards are where a naive model goes wrong, so the shape matters more than the size:

- **They have editions.** ISO 9001:2015 and its successor are neither the same standard nor unrelated ones. A record of conformity that does not say to which issue says very little.
- **Their text is usually copyrighted.** A deployment may hold a licence to read ISO 9001 without any right to store or redistribute its wording.
- **Not every standard is published.** An organization's own policies state requirements too, and they are not second-class.
- **Clause references are not identifiers.** `7.5.3` means something inside one standard and nothing outside it, and `7.10` sorts before `7.9`.

## Decision

Two tables, `standard` and `requirement`, both tenant-owned like everything else.

**One row per issue.** `standard` carries `name` and `edition` and is unique on `(organization, name, edition)`. ISO 9001:2015 and ISO 9001:2026 are two rows. That is not a workaround for lacking a version model — it is the model: a requirement belongs to an issue of a standard, and a clause that changed between issues is a different requirement that happens to share a reference.

**Every organization holds its own copy.** A shared catalogue of standards visible to all tenants was considered and rejected. It would mean a domain table whose `organization_id` is sometimes null, which breaks the single policy shape every tenant-owned table has ([ADR 0003](0003-tenant-isolation-with-row-level-security.md)) and the invariant that a domain row belongs to exactly one organization. It also sits badly with licensing, where the question is what _this_ deployment may hold. Distributing a standard is then an import — content that arrives from a file or a catalogue and becomes that organization's rows — rather than a second class of row with a second set of rules. The duplication is a few thousand rows per organization, which is nothing, and it leaves room for an organization to annotate its own copy later without a second class of row to put the annotation on.

**The requirement text is nullable.** A licence to read is not a licence to store. A requirement tracked by reference and title alone is still worth having: once controls can answer to requirements, none of that needs the copyrighted wording to work. This is the one place the schema is shaped by a legal constraint rather than a domain one, and it is worth being explicit that it was deliberate.

**Order is a column, not a derivation.** `position` records where a requirement falls in its standard. Sorting by `reference` puts `7.10` before `7.9`, and any scheme clever enough to fix that is a scheme that breaks on `A.5.1` or `CC6.1`.

It is not unique within a standard. Allowing ties lets a clause use an occupied position without shifting later clauses. The tradeoff is that tied clauses are ordered by identifier, not by an additional author-assigned rank: the order is `(position, id)` in the index and in every reader.

**A requirement carries its own `organization_id`, and a composite foreign key keeps it honest:**

```sql
FOREIGN KEY ("standard_id", "organization_id")
  REFERENCES "standard" ("id", "organization_id") ON DELETE CASCADE
```

Denormalising the organization onto a child row is what lets one policy shape serve every tenant-owned table — no join in a policy, no table needing its own. The composite key is what stops that being a lie: referencing `(id, organization_id)` rather than `id` alone makes a requirement in one organization pointing at a standard in another _impossible to write_, rather than merely wrong. `ARCHITECTURE.md` asks that cross-tenant relationships be impossible unless explicitly modelled; this is how a tenant-owned child does that.

The pattern is for **relationships within one tenant**, and only those. A grandchild references its immediate parent the same way — `(parent_id, organization_id)`, with that parent carrying the matching unique constraint — rather than accumulating every ancestor. A reference to something instance-wide, `user` above all, takes an ordinary foreign key and is authorized separately: there is no organization on the other side to agree with. Nor does `ON DELETE CASCADE` follow automatically; it suits a requirement, whose existence is its standard's, and would be wrong for a relationship that should refuse deletion instead.

The unique constraint this references is a table constraint rather than a unique index, because a constraint is part of `CREATE TABLE` and is therefore already there when the referencing table's foreign key is added.

## Consequences

Mapping a requirement across editions has no home yet, and will need one — an organization that moves from ISO 9001:2015 to its successor will want to know which controls carry over. That is a table relating two requirements, and it can be added without disturbing anything here, which is the point of not inventing it now.

Requirements were not yet related to controls when this was written; [ADR 0010](0010-mapping-controls-to-requirements.md) relates them. `control_requirement` was the next table and the reason both of these exist; it should be keyed by its two foreign keys and carries nothing else until a mapping genuinely needs metadata.

Nothing imported a standard when this was written; [ADR 0009](0009-importing-a-standard.md) added the import. Creating requirements one at a time is not how anyone enters a standard with 300 clauses, so the API for this is a bulk import rather than the create-one-at-a-time shape `control` has — which is exactly why the API was left out of this decision instead of being assumed to match. The constraints here stop a duplicate standard and a duplicate clause, but they cannot make an import atomic or resumable; that is the importer's transaction to own, and it also owns assigning positions.

**Requirements need a different collection order.** [ADR 0006](0006-cursor-paged-collections.md) initially used `(created_at, id)` descending; a standard's clauses need `(position, id)` ascending. [ADR 0009](0009-importing-a-standard.md) added named orderings and integer cursor keys to support this, retaining the timestamp ordering for controls and standards.

A standard and its requirements are ordinary mutable rows. Adopting an edition does not freeze it, and nothing marks one final (VERSION-01) — a typo in a title is meant to be fixable. What changed is recorded in `audit_event`: an import is one event for the standard ([ADR 0009](0009-importing-a-standard.md)), not one per clause. Deleting a standard deletes its requirements, by the cascade above.

Identity is the exact string once surrounding whitespace is removed. `ISO 9001` and `ISO9001` are two standards, and nothing canonicalises spelling, case or inner whitespace beyond that. An importer is where that belongs, because only it knows what the input was meant to say.

`text` being nullable means "not stored", not "does not exist", and nothing yet records _why_. If a deployment needs to distinguish "we are not licensed to store this" from "nobody has typed it in", that is a column, and it should be added when something acts on the difference rather than in anticipation of it.
