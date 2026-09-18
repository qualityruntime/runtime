-- SPDX-FileCopyrightText: 2026 Quality Runtime contributors
-- SPDX-License-Identifier: Apache-2.0

-- What PostgreSQL enforces, rather than what the application remembers.
--
-- Hand-written. drizzle-kit can declare policies but not FORCE, functions or
-- triggers, and splitting one security boundary across two mechanisms would be
-- worse than keeping all of it in one readable file.
--
-- `withOrganization` in ../tenant.ts opens a transaction and sets
-- `qualityruntime.organization_id` for its duration; every policy here decides
-- what that transaction may see and write. Outside one, `current_setting(…,
-- true)` yields NULL on a fresh connection and the empty string on a pooled one
-- that has held a tenant before — PostgreSQL restores a custom setting to ''
-- rather than forgetting it. Neither equals a row's organization, so a code
-- path that forgot to open a tenant context sees an empty database rather than
-- every tenant's. See docs/adr/0003-tenant-isolation-with-row-level-security.md.
--
-- A policy is a *test*, not a lock, wherever it reads a row other than the one
-- being written — or code reads something first and writes on the strength of
-- it. Under `read committed` that read sees a snapshot taken before a
-- concurrent transaction committed, so it also needs a row lock the other
-- writer contends for. (A command's own target row is different: PostgreSQL
-- locks it and re-checks the predicate against the latest version.)
-- docs/adr/0020-testing-races.md names each place that matters and which lock
-- it takes.

-- Without FORCE, PostgreSQL exempts a table's owner. A deployment separates the
-- migrator that owns the schema from the role the server connects as, so the
-- server is not an owner — but FORCE means the guarantee does not depend on
-- that being got right. Superusers and BYPASSRLS roles are exempt even with it,
-- which `assertTenantIsolation` refuses to start under.
ALTER TABLE "control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "standard" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "standard" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "requirement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "requirement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "control_requirement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "control_requirement" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "file" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "file" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Tenancy, where that is the whole rule. One policy covering every command:
-- WITH CHECK applies the same test to writes, so a transaction cannot label a
-- row with another tenant's id.
CREATE POLICY "standard_tenant_isolation" ON "standard"
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "requirement_tenant_isolation" ON "requirement"
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

-- A mapping is a statement about a control and a requirement that are already
-- known to be this tenant's — the composite foreign keys see to that — so the
-- link needs nothing narrower than tenancy. It is made or unmade, never
-- changed: there is no UPDATE policy, because rewriting a link in place would
-- move a mapping without either end hearing about it.
CREATE POLICY "control_requirement_tenant_read" ON "control_requirement" FOR SELECT
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "control_requirement_tenant_map" ON "control_requirement" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "control_requirement_tenant_unmap" ON "control_requirement" FOR DELETE
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

-- Audit history is append-only to the application. No UPDATE or DELETE policy
-- exists, so no code path can rewrite or erase an event through its tenant
-- context — not a rule the handlers follow, a rule they cannot break.
-- `TRUNCATE` and a table owner's privileges are outside row security, so
-- docs/deployment.md also revokes those. See docs/adr/0005-audit-history.md.
CREATE POLICY "audit_event_tenant_read" ON "audit_event" FOR SELECT
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "audit_event_tenant_append" ON "audit_event" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

-- Evidence is final once attested: the UPDATE and DELETE policies see only
-- unattested rows, so correcting an attestation means recording new evidence
-- rather than editing the old. Naming each command is what allows that — one
-- policy covering all four could not say it. See
-- docs/adr/0012-evidence-and-attestation.md.
--
-- A consequence worth knowing: `SELECT … FOR UPDATE` is governed by the UPDATE
-- policy, so an attested row cannot be *locked* either. A handler that locks
-- before deciding would read "cannot be locked" as "does not exist", which is
-- why the evidence handlers read unlocked first to tell 404 from 409.
CREATE POLICY "evidence_tenant_read" ON "evidence" FOR SELECT
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "evidence_tenant_record" ON "evidence" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "evidence_tenant_amend" ON "evidence" FOR UPDATE
  USING (
    "organization_id" = current_setting('qualityruntime.organization_id', true)
    AND "attested_at" IS NULL
  )
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "evidence_tenant_discard" ON "evidence" FOR DELETE
  USING (
    "organization_id" = current_setting('qualityruntime.organization_id', true)
    AND "attested_at" IS NULL
  );--> statement-breakpoint

-- A file follows its evidence: nothing may be attached to an attested record,
-- and nothing is ever detached — a file goes only when its unattested evidence
-- is discarded, by the foreign key's cascade. A row whose attachments could
-- still change is not final, and the rule above would be hollow without this.
--
-- So the policies are tenancy alone: there is no UPDATE policy, because a file
-- row describes bytes already written, and no DELETE policy, because nothing
-- detaches. Whether the evidence is still open is the trigger's to decide,
-- because it needs a lock and a policy cannot take one.
CREATE POLICY "file_tenant_read" ON "file" FOR SELECT
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "file_tenant_attach" ON "file" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

-- An attachment locks its evidence `FOR NO KEY UPDATE` and requires it
-- unattested. A test alone is not enough: under `read committed` it would see
-- the draft while an attestation sat uncommitted beside it, and the `FOR KEY
-- SHARE` the foreign key takes does not conflict with the attestation's
-- `UPDATE`. This lock does, so the insert waits for the signature and then
-- sees it. Here rather than in the handler so that no insert path can forget
-- it.
--
-- The lock is itself governed by evidence's UPDATE policy, which admits only
-- this tenant's unattested rows, so not finding the row covers all three ways
-- it can be closed: attested, another tenant's, or not there.
--
-- Both functions here pin `search_path` with `pg_temp` last and qualify every
-- table. Left implicit, `pg_temp` is searched *first* for relations, and any
-- role may create a temporary table: an unqualified `evidence` could then be
-- an impostor holding a fake unattested row, and the real one would gain a
-- file.
CREATE FUNCTION "file_evidence_open"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM FROM "public"."evidence"
    WHERE "id" = NEW."evidence_id"
      AND "organization_id" = NEW."organization_id"
      AND "attested_at" IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file can only be attached to unattested evidence'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "file_evidence_open"
  BEFORE INSERT ON "file"
  FOR EACH ROW EXECUTE FUNCTION "file_evidence_open"();--> statement-breakpoint

-- A control that was in effect is part of the record and is retired rather than
-- removed. One that never took effect was never relied on, and an abandoned
-- draft would otherwise have no disposal at all, because the lifecycle offers no
-- `draft → retired`. See docs/adr/0017-discarding-a-draft-control.md.
--
-- So only a draft may be deleted. `control_took_effect_unless_draft` and
-- `control_lifecycle_enforce` below are what let that status test mean "never
-- took effect": no control that was in effect can be a draft again, by any
-- statement.
--
-- `SELECT … FOR UPDATE` is charged to UPDATE, so the amend policy is also what
-- lets a handler lock a control before deciding about it, whatever its status.
CREATE POLICY "control_tenant_read" ON "control" FOR SELECT
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "control_tenant_author" ON "control" FOR INSERT
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "control_tenant_amend" ON "control" FOR UPDATE
  USING ("organization_id" = current_setting('qualityruntime.organization_id', true))
  WITH CHECK ("organization_id" = current_setting('qualityruntime.organization_id', true));--> statement-breakpoint

CREATE POLICY "control_tenant_discard" ON "control" FOR DELETE
  USING (
    "organization_id" = current_setting('qualityruntime.organization_id', true)
    AND "status" = 'draft'
  );--> statement-breakpoint

-- The two lifecycle rules that need a row's past, which only a trigger can
-- see — WITH CHECK and a CHECK constraint see the new row alone. Everything
-- else about which states are valid is `control_took_effect_unless_draft`.
--
-- `activated_at` is set when a control first takes effect, and never again —
-- by the database, not by the application. The CHECK ties a draft to a null
-- stamp, so anything able to clear it could turn a control that was in effect
-- back into a deletable draft: `UPDATE … SET status = 'draft', activated_at =
-- NULL` then a `DELETE`. Assigning the value here, and only here, also means
-- activation by any path is recorded, and nobody can backdate it or stamp a
-- control that never took effect.
--
-- Retirement is terminal. A retired control keeps its stamp, so the CHECK
-- would admit it becoming active again; what replaces it is a new control,
-- so evidence recorded against the old one keeps meaning what it meant.
CREATE FUNCTION "control_lifecycle_enforce"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Refused rather than ignored: a caller that tried is doing something it
  -- should hear about.
  IF TG_OP = 'INSERT' THEN
    IF NEW."activated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'control.activated_at is set by the database and cannot be written'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW."activated_at" IS DISTINCT FROM OLD."activated_at" THEN
      RAISE EXCEPTION 'control.activated_at is set by the database and cannot be written'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'retired' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'a retired control stays retired'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Taking effect is what sets it, whoever does the taking.
  IF NEW."status" = 'active' AND NEW."activated_at" IS NULL THEN
    NEW."activated_at" := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "control_lifecycle_enforce"
  BEFORE INSERT OR UPDATE ON "control"
  FOR EACH ROW EXECUTE FUNCTION "control_lifecycle_enforce"();
