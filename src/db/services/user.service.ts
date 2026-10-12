import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import { AppError, notFound } from "../../lib/error";
import { MIN_PASSWORD_LENGTH } from "../../lib/auth/auth";
import { presetLabelFor, presetRows, type PresetName } from "../../lib/auth/presets";
import { authAccount, authUser } from "../../lib/auth/schema";
import { db, type DbOrTx } from "../client";
import {
  countOtherActiveManagers,
  deletePermissionsForUser,
  insertPermissions,
  listPermissionsByUser,
  listPermissionsForUsers,
} from "../repositories/user-permission.repository";
import {
  deleteAuthSessionsForUser,
  deleteOtherAuthSessionsForUser,
  findCredentialAccount,
  findUserById,
  latestSignInByUserIds,
  listUsersByOrg,
  updateUserById,
} from "../repositories/user.repository";

export type CreateUserInput = {
  email: string;
  name: string;
  password: string;
  preset: PresetName;
  organizationId: number;
  // set on an admin-created account and on a password reset
  mustChangePassword?: boolean;
};

export type UserRow = typeof authUser.$inferSelect;

// flow: user row > credential account > preset rows
// One transaction: a half-created account would be a user who cannot sign in,
// or one who can but holds no rights.
export const createUser = async (
  input: CreateUserInput,
  database?: DbOrTx,
): Promise<UserRow> => {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new AppError(400, "validation_error", "Email is required");
  if (!input.name.trim()) throw new AppError(400, "validation_error", "Name is required");
  // the floor lives here, not only at the route: the seed creates accounts too
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(
      400,
      "validation_error",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const run = async (tx: DbOrTx) => {
    const existing = await tx
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new AppError(409, "wrong_state", "An account with that email already exists");
    }

    // an id the app owns: better-auth accepts any text id, and the account row
    // needs it before the user is returned
    const userId = crypto.randomUUID();

    const created = await tx
      .insert(authUser)
      .values({
        id: userId,
        name: input.name.trim(),
        email,
        emailVerified: true,
        organizationId: input.organizationId,
        mustChangePassword: input.mustChangePassword ?? true,
      })
      .returning();

    const user = created[0]!;

    await tx.insert(authAccount).values({
      id: crypto.randomUUID(),
      accountId: user.id,
      // the provider id better-auth's email/password sign-in looks for
      providerId: "credential",
      userId: user.id,
      password: await hashPassword(input.password),
    });

    await insertPermissions(
      presetRows(input.preset).map((grant) => ({
        userId: user.id,
        action: grant.action,
        subject: grant.subject,
      })),
      tx,
    );

    return user;
  };

  return database ? run(database) : db.transaction(run);
};

// flow: new hash > new account row > sessions revoked by the caller
export const setUserPassword = async (
  userId: string,
  password: string,
  database: DbOrTx = db,
): Promise<void> => {
  const hashed = await hashPassword(password);

  await database
    .update(authAccount)
    .set({ password: hashed, updatedAt: new Date() })
    .where(eq(authAccount.userId, userId));
};

// The lockout guard. Refusing to remove `manage User` from the last active
// holder keeps the deployment administrable. It throws a 409, never a crash.
// flow: will they still hold it? > yes, done : count the others > zero, refuse
const assertKeepsAManager = async (
  targetUserId: string,
  organizationId: number,
  willStillHold: boolean,
  database: DbOrTx,
): Promise<void> => {
  if (willStillHold) return;

  // a target who never held it cannot lock anyone out
  const current = await listPermissionsByUser(targetUserId, database);
  const holdsIt = current.some((row) => row.action === "manage" && row.subject === "User");
  if (!holdsIt) return;

  if ((await countOtherActiveManagers(organizationId, targetUserId, database)) === 0) {
    throw new AppError(
      409,
      "wrong_state",
      "This is the last account that can manage users",
    );
  }
};

// Replace a user's whole set. Delete and insert share one transaction so the
// window where a user holds no rights is never visible.
export const replaceUserPermissions = async (
  userId: string,
  organizationId: number,
  rows: Array<{ action: string; subject: string; conditions?: unknown }>,
  database?: DbOrTx,
): Promise<void> => {
  const keepsManager = rows.some((row) => row.action === "manage" && row.subject === "User");

  const run = async (tx: DbOrTx) => {
    await assertKeepsAManager(userId, organizationId, keepsManager, tx);

    await deletePermissionsForUser(userId, tx);
    await insertPermissions(
      rows.map((row) => ({
        userId,
        action: row.action,
        subject: row.subject,
        conditions: row.conditions ?? null,
      })),
      tx,
    );
  };

  return database ? run(database) : db.transaction(run);
};

/* =========================================================
   ADMIN SURFACE
========================================================= */

export type UserListItem = {
  userId: string;
  name: string;
  email: string;
  preset: PresetName | "Custom";
  disabled: boolean;
  mustChangePassword: boolean;
  // The newest session row for the account, or null when it never signed in.
  lastSignInAt: string | null;
};

// flow: org's users > their rows + newest sign-in in one query each > label
// Three queries, not one per user.
export const listUsers = async (
  organizationId: number,
  database: DbOrTx = db,
): Promise<UserListItem[]> => {
  const users = await listUsersByOrg(organizationId, database);
  const userIds = users.map((user) => user.id);
  const [rows, lastSignIn] = await Promise.all([
    listPermissionsForUsers(userIds, database),
    latestSignInByUserIds(userIds, database),
  ]);

  const byUser = new Map<string, Array<{ action: string; subject: string }>>();
  for (const row of rows) {
    const bucket = byUser.get(row.userId) ?? [];
    bucket.push({ action: row.action, subject: row.subject });
    byUser.set(row.userId, bucket);
  }

  return users.map((user) => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    preset: presetLabelFor(byUser.get(user.id) ?? []),
    disabled: user.disabled,
    mustChangePassword: user.mustChangePassword,
    lastSignInAt: lastSignIn.get(user.id)?.toISOString() ?? null,
  }));
};

// A user of this org, or null. A cross-org id answers null so the route can
// return 404 rather than admit the row exists elsewhere.
export const getOrgUser = async (
  userId: string,
  organizationId: number,
  database: DbOrTx = db,
): Promise<UserRow | null> => {
  const user = await findUserById(userId, database);
  if (!user || user.organizationId !== organizationId) return null;
  return user;
};

// Modify the display name or the disabled flag. Disabling the last manager is
// refused for the same reason removing their right is.
export const updateUser = async (
  userId: string,
  organizationId: number,
  patch: { name?: string; disabled?: boolean },
  database?: DbOrTx,
): Promise<UserRow | null> => {
  const run = async (tx: DbOrTx) => {
    const existing = await getOrgUser(userId, organizationId, tx);
    if (!existing) return null;

    if (patch.disabled === true && !existing.disabled) {
      await assertKeepsAManager(userId, organizationId, false, tx);
    }

    const data: Partial<typeof authUser.$inferInsert> = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.disabled !== undefined) data.disabled = patch.disabled;

    return updateUserById(userId, data, tx);
  };

  return database ? run(database) : db.transaction(run);
};

// 18 random bytes as urlsafe base64: 24 characters, over the 12 character floor
export const mintPassword = (): string => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

// flow: mint password > new hash + must-change flag > revoke every session
// The plaintext is returned once and never stored. Read it off the wire now or
// reset again.
export const resetUserPassword = async (
  userId: string,
  organizationId: number,
  database?: DbOrTx,
): Promise<{ password: string; revokedSessions: number } | null> => {
  const run = async (tx: DbOrTx) => {
    const existing = await getOrgUser(userId, organizationId, tx);
    if (!existing) return null;

    const password = mintPassword();
    await setUserPassword(userId, password, tx);
    await updateUserById(userId, { mustChangePassword: true }, tx);
    // a stolen token must die with the old password
    const revokedSessions = await deleteAuthSessionsForUser(userId, tx);

    return { password, revokedSessions };
  };

  return database ? run(database) : db.transaction(run);
};

// The caller's own rows, read-only. Any signed-in user may ask.
export const listOwnPermissions = async (userId: string, database: DbOrTx = db) =>
  listPermissionsByUser(userId, database);

/* =========================================================
   SELF-SERVICE
========================================================= */

export type UpdateOwnAccountInput = {
  name?: string;
  // Always required: this write is what changes an identity field.
  currentPassword: string;
  newPassword?: string;
};

// The person edits their own display name and password. Email, preset and org
// stay with an admin: they are identity fields.
//
// flow: current password > name and/or hash > other sessions dropped
export const updateOwnAccount = async (
  userId: string,
  sessionId: string,
  input: UpdateOwnAccountInput,
  database?: DbOrTx,
): Promise<UserRow> => {
  const run = async (tx: DbOrTx): Promise<UserRow> => {
    const existing = await findUserById(userId, tx);
    if (!existing) throw notFound("User");

    const account = await findCredentialAccount(userId, tx);
    const matches = account?.password
      ? await verifyPassword({ hash: account.password, password: input.currentPassword })
      : false;
    if (!matches) {
      throw new AppError(400, "wrong_password", "Current password is incorrect");
    }

    const data: Partial<typeof authUser.$inferInsert> = {};

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new AppError(400, "validation_error", "Name is required");
      data.name = name;
    }

    if (input.newPassword !== undefined) {
      if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AppError(
          400,
          "validation_error",
          `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        );
      }
      await setUserPassword(userId, input.newPassword, tx);
      // the first sign-in flag clears with the password it asked for
      data.mustChangePassword = false;
    }

    const updated =
      Object.keys(data).length > 0 ? await updateUserById(userId, data, tx) : existing;
    if (!updated) throw notFound("User");

    // A new password cuts every other machine off. This session survives, so
    // the person is not signed out of the window they are looking at.
    if (input.newPassword !== undefined) {
      await deleteOtherAuthSessionsForUser(userId, sessionId, tx);
    }

    return updated;
  };

  return database ? run(database) : db.transaction(run);
};
