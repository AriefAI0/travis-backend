import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { authUser, userPermission } from "../../lib/auth/schema";
import { db, type DbOrTx } from "../client";

export type PermissionRow = typeof userPermission.$inferSelect;
export type PermissionInsert = typeof userPermission.$inferInsert;

// The ability builder's only read: every row for one user. Indexed on userId,
// so this stays one cheap query per request.
export const listPermissionsByUser = async (
  userId: string,
  database: DbOrTx = db,
): Promise<PermissionRow[]> =>
  database.select().from(userPermission).where(eq(userPermission.userId, userId));

// Clear one user's set. A service pairs this with insertPermissions inside one
// transaction — a half-replaced set would grant or revoke the wrong rights.
export const deletePermissionsForUser = async (
  userId: string,
  database: DbOrTx = db,
): Promise<void> => {
  await database.delete(userPermission).where(eq(userPermission.userId, userId));
};

// One row per granted action and subject.
export const insertPermissions = async (
  rows: PermissionInsert[],
  database: DbOrTx = db,
): Promise<PermissionRow[]> => {
  // drizzle rejects an empty values() call
  if (rows.length === 0) return [];

  return database.insert(userPermission).values(rows).returning();
};

// Every row for a set of users, in one query. The user list needs all of them
// at once to label each row with its preset.
export const listPermissionsForUsers = async (
  userIds: string[],
  database: DbOrTx = db,
): Promise<PermissionRow[]> => {
  if (userIds.length === 0) return [];

  return database
    .select()
    .from(userPermission)
    .where(inArray(userPermission.userId, userIds));
};

// How many OTHER enabled accounts still hold `manage User` in this org.
// The lockout guard reads this: zero means the target is the last one.
export const countOtherActiveManagers = async (
  organizationId: number,
  excludingUserId: string,
  database: DbOrTx = db,
): Promise<number> => {
  const rows = await database
    .select({ total: sql<number>`count(distinct ${authUser.id})`.mapWith(Number) })
    .from(authUser)
    .innerJoin(userPermission, eq(userPermission.userId, authUser.id))
    .where(
      and(
        eq(authUser.organizationId, organizationId),
        eq(authUser.disabled, false),
        ne(authUser.id, excludingUserId),
        eq(userPermission.action, "manage"),
        eq(userPermission.subject, "User"),
      ),
    );

  return rows[0]?.total ?? 0;
};
