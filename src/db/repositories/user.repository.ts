import { asc, eq } from "drizzle-orm";

import { authSession, authUser } from "../../lib/auth/schema";
import { db, type DbOrTx } from "../client";

export type UserRow = typeof authUser.$inferSelect;

// Everyone in one org, oldest first so the table order is stable.
export const listUsersByOrg = async (
  organizationId: number,
  database: DbOrTx = db,
): Promise<UserRow[]> =>
  database
    .select()
    .from(authUser)
    .where(eq(authUser.organizationId, organizationId))
    .orderBy(asc(authUser.createdAt));

export const findUserById = async (
  userId: string,
  database: DbOrTx = db,
): Promise<UserRow | null> =>
  (await database.select().from(authUser).where(eq(authUser.id, userId)).limit(1))[0] ?? null;

export const updateUserById = async (
  userId: string,
  data: Partial<typeof authUser.$inferInsert>,
  database: DbOrTx = db,
): Promise<UserRow | null> =>
  (
    await database
      .update(authUser)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(authUser.id, userId))
      .returning()
  )[0] ?? null;

// Every live sign-in for one account. A password reset drops them all, so a
// stolen token stops working the moment the password changes.
export const deleteAuthSessionsForUser = async (
  userId: string,
  database: DbOrTx = db,
): Promise<number> => {
  const removed = await database
    .delete(authSession)
    .where(eq(authSession.userId, userId))
    .returning({ id: authSession.id });

  return removed.length;
};
