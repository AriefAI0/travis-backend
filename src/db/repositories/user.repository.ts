import { and, asc, desc, eq, inArray, not, sql } from "drizzle-orm";

import { authAccount, authSession, authUser } from "../../lib/auth/schema";
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

// The newest sign-in per account: a session row is created when one signs in,
// so the latest one is the last time that happened. One query for the whole
// list, not one per row.
export const latestSignInByUserIds = async (
  userIds: string[],
  database: DbOrTx = db,
): Promise<Map<string, Date>> => {
  if (userIds.length === 0) return new Map();

  const rows = await database
    .select({ userId: authSession.userId, createdAt: authSession.createdAt })
    .from(authSession)
    .where(inArray(authSession.userId, userIds))
    .orderBy(desc(authSession.createdAt));

  const latest = new Map<string, Date>();
  for (const row of rows) {
    if (!latest.has(row.userId)) latest.set(row.userId, row.createdAt);
  }

  return latest;
};

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

// Every session but the caller's. A self-service password change cuts off the
// other machines without signing the person out of the one they are on.
export const deleteOtherAuthSessionsForUser = async (
  userId: string,
  keepSessionId: string,
  database: DbOrTx = db,
): Promise<number> => {
  const removed = await database
    .delete(authSession)
    .where(
      and(eq(authSession.userId, userId), not(eq(authSession.id, keepSessionId))),
    )
    .returning({ id: authSession.id });

  return removed.length;
};

// flow: login handle > the account's email, matching whatever case was typed
// Null when no account holds the handle, so the caller can fall through.
export const emailByUsername = async (
  username: string,
  database: DbOrTx = db,
): Promise<string | null> =>
  (
    await database
      .select({ email: authUser.email })
      .from(authUser)
      .where(sql`lower(${authUser.username}) = ${username.toLowerCase()}`)
      .limit(1)
  )[0]?.email ?? null;

// The credential row holding the password hash. Null on an account with no
// password provider, which cannot pass a current-password check.
export const findCredentialAccount = async (
  userId: string,
  database: DbOrTx = db,
): Promise<typeof authAccount.$inferSelect | null> =>
  (
    await database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, "credential")))
      .limit(1)
  )[0] ?? null;
