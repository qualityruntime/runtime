-- SPDX-FileCopyrightText: 2026 Quality Runtime contributors
-- SPDX-License-Identifier: Apache-2.0

CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"on_behalf_of_id" text,
	"on_behalf_of_label" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "audit_event_id_format" CHECK ("id" ~ '^aud_[0-9a-z]{16}$'),
	CONSTRAINT "audit_event_actor_type_valid" CHECK ("actor_type" in ('user', 'system')),
	CONSTRAINT "audit_event_actor_is_identified" CHECK (("actor_type" = 'user' and "actor_id" is not null and "actor_id" ~ '^usr_[0-9a-z]{16}$') or ("actor_type" = 'system' and "actor_id" is null)),
	CONSTRAINT "audit_event_on_behalf_of_is_identified" CHECK (("on_behalf_of_id" is not null and "on_behalf_of_id" ~ '^usr_[0-9a-z]{16}$') or ("on_behalf_of_id" is null and "on_behalf_of_label" is null)),
	CONSTRAINT "audit_event_action_present" CHECK ("audit_event"."action" ~ '[^[:space:]]'),
	CONSTRAINT "audit_event_resource_type_present" CHECK ("audit_event"."resource_type" ~ '[^[:space:]]'),
	CONSTRAINT "audit_event_resource_id_present" CHECK ("audit_event"."resource_id" ~ '[^[:space:]]'),
	CONSTRAINT "audit_event_before_is_object" CHECK ("audit_event"."before" is null or jsonb_typeof("audit_event"."before") = 'object'),
	CONSTRAINT "audit_event_after_is_object" CHECK ("audit_event"."after" is null or jsonb_typeof("audit_event"."after") = 'object')
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_id_format" CHECK ("id" ~ '^acc_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL,
	CONSTRAINT "invitation_id_format" CHECK ("id" ~ '^inv_[0-9a-z]{24}$')
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_id_format" CHECK ("id" ~ '^mem_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organization_id_format" CHECK ("id" ~ '^org_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token"),
	CONSTRAINT "session_id_format" CHECK ("id" ~ '^ses_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factor_id_format" CHECK ("id" ~ '^tfa_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_id_format" CHECK ("id" ~ '^usr_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_id_format" CHECK ("id" ~ '^ver_[0-9a-z]{16}$')
);
--> statement-breakpoint
CREATE TABLE "control" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_id_organization_id_key" UNIQUE("id","organization_id"),
	CONSTRAINT "control_id_format" CHECK ("id" ~ '^ctl_[0-9a-z]{16}$'),
	CONSTRAINT "control_status_valid" CHECK ("status" in ('draft', 'active', 'retired')),
	CONSTRAINT "control_took_effect_unless_draft" CHECK (("control"."status" = 'draft') = ("control"."activated_at" is null)),
	CONSTRAINT "control_name_present" CHECK ("control"."name" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"control_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"attested_at" timestamp with time zone,
	"attested_by_id" text,
	"attested_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_id_organization_id_key" UNIQUE("id","organization_id"),
	CONSTRAINT "evidence_id_format" CHECK ("id" ~ '^evd_[0-9a-z]{16}$'),
	CONSTRAINT "evidence_title_present" CHECK ("evidence"."title" ~ '[^[:space:]]'),
	CONSTRAINT "evidence_attestation_complete" CHECK ((
        "attested_at" is null
          and "attested_by_id" is null
          and "attested_by_label" is null
      ) or (
        "attested_at" is not null
          and "attested_by_id" is not null
          and "attested_by_id" ~ '^usr_[0-9a-z]{16}$'
      ))
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_id_evidence_id_organization_id_key" UNIQUE("id","evidence_id","organization_id"),
	CONSTRAINT "file_id_format" CHECK ("id" ~ '^fil_[0-9a-z]{16}$'),
	CONSTRAINT "file_filename_present" CHECK ("file"."filename" ~ '[^[:space:]]'),
	CONSTRAINT "file_filename_bytes" CHECK (octet_length("file"."filename") <= 255),
	CONSTRAINT "file_content_type_shape" CHECK ("content_type" ~ '^[A-Za-z0-9!#$%&*+.^_|~-]+/[A-Za-z0-9!#$%&*+.^_|~-]+$'),
	CONSTRAINT "file_bytes_positive" CHECK ("file"."bytes" > 0),
	CONSTRAINT "file_checksum_is_sha256" CHECK ("file"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "file_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_upload_file_id_key" UNIQUE("file_id"),
	CONSTRAINT "file_upload_id_format" CHECK ("id" ~ '^upl_[0-9a-z]{16}$'),
	CONSTRAINT "file_upload_filename_present" CHECK ("file_upload"."filename" ~ '[^[:space:]]'),
	CONSTRAINT "file_upload_filename_bytes" CHECK (octet_length("file_upload"."filename") <= 255),
	CONSTRAINT "file_upload_content_type_shape" CHECK ("content_type" ~ '^[A-Za-z0-9!#$%&*+.^_|~-]+/[A-Za-z0-9!#$%&*+.^_|~-]+$')
);
--> statement-breakpoint
CREATE TABLE "control_requirement" (
	"organization_id" text NOT NULL,
	"control_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_requirement_control_id_requirement_id_pk" PRIMARY KEY("control_id","requirement_id")
);
--> statement-breakpoint
CREATE TABLE "requirement" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"standard_id" text NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_id_organization_id_key" UNIQUE("id","organization_id"),
	CONSTRAINT "requirement_id_format" CHECK ("id" ~ '^req_[0-9a-z]{16}$'),
	CONSTRAINT "requirement_reference_present" CHECK ("reference" ~ '[^[:space:]]'),
	CONSTRAINT "requirement_title_present" CHECK ("title" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "standard" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"edition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standard_id_organization_id_key" UNIQUE("id","organization_id"),
	CONSTRAINT "standard_id_format" CHECK ("id" ~ '^std_[0-9a-z]{16}$'),
	CONSTRAINT "standard_name_present" CHECK ("name" ~ '[^[:space:]]'),
	CONSTRAINT "standard_edition_present" CHECK ("edition" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control" ADD CONSTRAINT "control_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_control_fk" FOREIGN KEY ("control_id","organization_id") REFERENCES "public"."control"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_evidence_fk" FOREIGN KEY ("evidence_id","organization_id") REFERENCES "public"."evidence"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_upload" ADD CONSTRAINT "file_upload_evidence_fk" FOREIGN KEY ("evidence_id","organization_id") REFERENCES "public"."evidence"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_upload" ADD CONSTRAINT "file_upload_file_fk" FOREIGN KEY ("file_id","evidence_id","organization_id") REFERENCES "public"."file"("id","evidence_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_requirement" ADD CONSTRAINT "control_requirement_control_fk" FOREIGN KEY ("control_id","organization_id") REFERENCES "public"."control"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_requirement" ADD CONSTRAINT "control_requirement_requirement_fk" FOREIGN KEY ("requirement_id","organization_id") REFERENCES "public"."requirement"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_standard_fk" FOREIGN KEY ("standard_id","organization_id") REFERENCES "public"."standard"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standard" ADD CONSTRAINT "standard_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_resource_idx" ON "audit_event" USING btree ("organization_id","resource_type","resource_id","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_event_organization_id_created_at_id_idx" ON "audit_event" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_id_account_id_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organization_id_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitation_inviter_id_idx" ON "invitation" USING btree ("inviter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_id_user_id_uidx" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_user_id_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_active_organization_id_idx" ON "session" USING btree ("active_organization_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "control_organization_id_created_at_id_idx" ON "control" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "evidence_organization_id_control_id_occurred_at_id_idx" ON "evidence" USING btree ("organization_id","control_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "file_organization_id_evidence_id_created_at_id_idx" ON "file" USING btree ("organization_id","evidence_id","created_at","id");--> statement-breakpoint
CREATE INDEX "file_upload_organization_id_expires_at_idx" ON "file_upload" USING btree ("organization_id","expires_at") WHERE "file_upload"."file_id" is null;--> statement-breakpoint
CREATE INDEX "file_upload_evidence_id_organization_id_idx" ON "file_upload" USING btree ("evidence_id","organization_id");--> statement-breakpoint
CREATE INDEX "control_requirement_organization_id_requirement_id_idx" ON "control_requirement" USING btree ("organization_id","requirement_id","control_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_standard_id_reference_uidx" ON "requirement" USING btree ("standard_id","reference");--> statement-breakpoint
CREATE INDEX "requirement_organization_id_standard_id_position_id_idx" ON "requirement" USING btree ("organization_id","standard_id","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "standard_organization_id_name_edition_uidx" ON "standard" USING btree ("organization_id","name","edition");--> statement-breakpoint
CREATE INDEX "standard_organization_id_created_at_id_idx" ON "standard" USING btree ("organization_id","created_at","id");