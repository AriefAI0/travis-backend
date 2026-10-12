import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "../../db/schema";

/* =========================================================
   BETTER-AUTH TABLES
   Physical names carry an `auth_` prefix: the domain already
   owns a `session` table, and one reading of "session" per
   database is enough. better-auth never sees the SQL name, so
   the prefix costs nothing.
========================================================= */

const createdAt = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

const updatedAt = {
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

// one row per account, id + email unique
export const authUser = pgTable("auth_user", {
  // text id: better-auth mints it, never the database
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // login handle beside the email: the seed writes one, sign-in accepts either
  username: text("username").unique(),

  // every account belongs to one org; the seeded default fills this until
  // multi-org lands
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organization.organizationId),

  // read by the sign-in path, cleared once the user sets their own password
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // disabled accounts keep their rows and their audit history
  disabled: boolean("disabled").notNull().default(false),

  ...createdAt,
  ...updatedAt,
});

// one row per live sign-in; deleting the user drops their sessions
export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    // sign-out and revoke both look a user's sessions up by user
    idxAuthSessionUser: index("idx_auth_session_user").on(table.userId),
  })
);

// one row per credential provider; password lives in `password`
export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),

    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),

    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    // hashed, never plaintext
    password: text("password"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxAuthAccountUser: index("idx_auth_account_user").on(table.userId),
  })
);

// short-lived tokens: verification links and password resets
export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxAuthVerificationIdentifier: index("idx_auth_verification_identifier").on(
      table.identifier
    ),
  })
);

/* =========================================================
   PERMISSIONS
   One row per granted action on a subject. No role column: the
   spec's tick-box UI needs a set, and a role cannot express
   "an operator who may also publish reports".
========================================================= */

export const userPermission = pgTable(
  "user_permission",
  {
    userPermissionId: integer("user_permission_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),

    action: text("action").notNull(),
    subject: text("subject").notNull(),
    // CASL conditions, e.g. a Structure level. Null means unconditional.
    conditions: jsonb("conditions"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    // the ability query is always "every row for this user"
    idxUserPermissionUser: index("idx_user_permission_user").on(table.userId),
    uqUserPermissionTriple: uniqueIndex("uq_user_permission_triple").on(
      table.userId,
      table.action,
      table.subject
    ),
  })
);

/* =========================================================
   AUDIT
   Append-only. Written inside the caller's transaction so a
   rolled-back write leaves no row behind.
========================================================= */

export const auditLog = pgTable(
  "audit_log",
  {
    auditLogId: integer("audit_log_id").primaryKey().generatedByDefaultAsIdentity(),

    organizationId: integer("organization_id")
      .notNull()
      .references(() => organization.organizationId),

    // nullable: a future system write has no actor, and removing a user must
    // never delete or block their history
    userId: text("user_id").references(() => authUser.id, { onDelete: "set null" }),

    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    // the row as it was and as it became; secrets stripped before insert
    before: jsonb("before"),
    after: jsonb("after"),

    ...createdAt,
  },
  (table) => ({
    // the read route filters by org, newest first
    idxAuditLogOrgCreated: index("idx_audit_log_org_created").on(
      table.organizationId,
      table.createdAt
    ),
    idxAuditLogResource: index("idx_audit_log_resource").on(
      table.resourceType,
      table.resourceId
    ),
  })
);

// The drizzle-adapter registry: better-auth looks a table up by MODEL NAME,
// so the keys here are its names, not our export names. Never merge this map
// into drizzle()'s schema — its `session` key would shadow the domain's.
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};

// The drizzle() registry: our export names, which do not collide with the
// domain model's.
export const authTables = {
  authUser,
  authSession,
  authAccount,
  authVerification,
  userPermission,
  auditLog,
};
