// SPDX-FileCopyrightText: 2026 Quality Runtime contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authentication and tenancy tables owned by Better Auth.
 *
 * Better Auth addresses tables by the key they are exported under, so the
 * export names below are its model names and must not be renamed; the physical
 * table and column names are ours. `apps/server/auth.test.ts` catches models and
 * fields this file is missing, but not column types or constraints; after
 * upgrading Better Auth, diff this against freshly generated reference output.
 *
 * Deliberate deviations from the generated output:
 * - `timestamptz` throughout, so audit history is unambiguous across zones.
 * - snake_case index names, matching the column naming.
 * - `createdAt` and `updatedAt` have database defaults; expiry timestamps
 *   must still be supplied by the writer.
 * - a unique membership per (organization, user); Better Auth checks for one
 *   before inserting, which races under concurrency.
 * - a unique account per (providerId, accountId); Better Auth looks accounts up
 *   by that pair and throws rather than guess when two match, but does not
 *   enforce it with a database constraint.
 * - `session.activeOrganizationId` is a real foreign key, so a session cannot
 *   keep pointing at a deleted tenant (TENANT-01).
 * - prefixed identifiers (see `../id.ts`), each enforced by a CHECK.
 *
 * No Drizzle `relations()` are declared: they serve Better Auth's opt-in join
 * mode (`advanced.database.joins`) and Drizzle's relational queries, neither of
 * which is in use. Add them alongside whichever one arrives first.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId, type IdType, idPattern } from "../id.ts";

/** A prefixed primary key, generated here when the writer does not supply one. */
const id = (model: IdType) =>
  text("id")
    .primaryKey()
    .$defaultFn(() => createId(model));

/**
 * Rejects an identifier that does not carry this table's prefix and shape.
 * `sql.raw` because a CHECK is DDL and cannot take a bound parameter.
 */
const idFormat = (table: string, model: IdType) =>
  check(`${table}_id_format`, sql.raw(`"id" ~ '${idPattern(model)}'`));

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** Fields beyond the Better Auth core come from the `admin` and `twoFactor` plugins. */
export const user = pgTable(
  "user",
  {
    id: id("user"),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
  },
  () => [idFormat("user", "user")],
);

export const session = pgTable(
  "session",
  {
    id: id("session"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /**
     * Which tenant the session is currently acting in — request context, not
     * authorization. Access is decided by the caller's `member` row, never by
     * this column alone.
     */
    activeOrganizationId: text("active_organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [
    idFormat("session", "session"),
    index("session_user_id_idx").on(table.userId),
    // Deleting an organization sets this null across every session.
    index("session_active_organization_id_idx").on(table.activeOrganizationId),
  ],
);

export const account = pgTable(
  "account",
  {
    id: id("account"),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("account", "account"),
    // Better Auth identifies an external account by this pair and throws when
    // more than one row matches, so a duplicate breaks sign-in. Its own schema
    // has no constraint for it, and an application-level check races.
    uniqueIndex("account_provider_id_account_id_uidx").on(table.providerId, table.accountId),
    index("account_user_id_idx").on(table.userId),
  ],
);

/** Short-lived tokens for email verification, password reset, and OTP delivery. */
export const verification = pgTable(
  "verification",
  {
    id: id("verification"),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idFormat("verification", "verification"),
    index("verification_identifier_idx").on(table.identifier),
  ],
);

/** The tenant boundary: every tenant-owned record resolves to one organization. */
export const organization = pgTable(
  "organization",
  {
    id: id("organization"),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: createdAt(),
    metadata: text("metadata"),
  },
  () => [idFormat("organization", "organization")],
);

export const member = pgTable(
  "member",
  {
    id: id("member"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    idFormat("member", "member"),
    uniqueIndex("member_organization_id_user_id_uidx").on(table.organizationId, table.userId),
    index("member_user_id_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: id("invitation"),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    idFormat("invitation", "invitation"),
    index("invitation_organization_id_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
    // Deleting a user cascades to the invitations they sent.
    index("invitation_inviter_id_idx").on(table.inviterId),
  ],
);

/** TOTP secrets and backup codes; `user.twoFactorEnabled` gates their use. */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: id("twoFactor"),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    idFormat("two_factor", "twoFactor"),
    // Verification looks a factor up by secret before it knows the user.
    index("two_factor_secret_idx").on(table.secret),
    index("two_factor_user_id_idx").on(table.userId),
  ],
);
