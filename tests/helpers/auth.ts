// Test auth: a user with a known password plus the bearer token that
// authenticates them. Mirrors what sign-in does, without the HTTP hop.
import { hashPassword } from "better-auth/crypto";

import { createAuth } from "../../src/lib/auth/auth";
import { presetRows, type PresetName } from "../../src/lib/auth/presets";
import { authAccount, authUser, userPermission } from "../../src/lib/auth/schema";
import { insertPermissions } from "../../src/db/repositories/user-permission.repository";
import { testDb, testOrgId, type TestDb } from "./db";

export const TEST_PASSWORD = "correct-horse-battery";

let nextUser = 0;

export type TestUser = {
  userId: string;
  name: string;
  email: string;
  token: string;
};

// flow: user row > credential account > preset rows > session > bearer token
export const createTestUser = async (
  options: {
    email?: string;
    password?: string;
    organizationId?: number;
    disabled?: boolean;
    // login handle beside the email
    username?: string;
    // pre-tick the boxes a preset grants, the way an admin would on creation
    preset?: PresetName;
  } = {},
  database: TestDb = testDb,
): Promise<TestUser> => {
  nextUser += 1;
  const name = `Test User ${nextUser}`;
  const email = options.email ?? `user${nextUser}@example.local`;
  const password = options.password ?? TEST_PASSWORD;

  const rows = await database
    .insert(authUser)
    .values({
      id: `test-user-${nextUser}-${Date.now()}`,
      name,
      email,
      emailVerified: true,
      // testOrgId is resolved in ensureTestDatabase, which every test file
      // runs in beforeAll before it calls this
      organizationId: options.organizationId ?? testOrgId,
      disabled: options.disabled ?? false,
      username: options.username,
    })
    .returning();

  const user = rows[0]!;

  await database.insert(authAccount).values({
    id: `test-account-${user.id}`,
    accountId: user.id,
    providerId: "credential",
    userId: user.id,
    password: await hashPassword(password),
  });

  if (options.preset) {
    await insertPermissions(
      presetRows(options.preset).map((grant) => ({
        userId: user.id,
        action: grant.action,
        subject: grant.subject,
      })),
      database,
    );
  }

  // the session's own token IS the bearer token the plugin validates
  const context = await createAuth(database).$context;
  const session = await context.internalAdapter.createSession(user.id);

  return { userId: user.id, name, email, token: session.token };
};

// One permission row: action on subject, optionally narrowed by conditions.
export const grant = async (
  userId: string,
  action: string,
  subject: string,
  database: TestDb = testDb,
  conditions?: Record<string, unknown>,
) => {
  await database.insert(userPermission).values({ userId, action, subject, conditions });
};

// bearer header for a token, ready to spread into a request
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
