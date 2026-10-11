import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";

import { corsAllowedOrigins, env } from "../../config/env";
import { db, type DbOrTx } from "../../db/client";
import { betterAuthSchema } from "./schema";

// The password floor. Every account is created by an admin, so this is the
// only quality gate a password passes.
export const MIN_PASSWORD_LENGTH = 12;

export const AUTH_BASE_PATH = "/api/v1/auth";

// flow: request > bearer plugin reads the header > session > auth user
// A factory, like every other data-layer entry point, so tests can bind an
// instance to the test database.
// Sign-up is off: an admin creates every account through /api/v1/users, and
// the seed writes the first one. Nothing self-registers.
export const createAuth = (database: DbOrTx = db) =>
  betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,

    database: drizzleAdapter(database, {
      provider: "pg",
      // keyed by better-auth's model names, not our export names
      schema: betterAuthSchema,
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      disableSignUp: true,
    },

    // Our own columns. input:false keeps a client from setting them: the org
    // comes from the caller's context and the flags from the service layer.
    user: {
      additionalFields: {
        organizationId: { type: "number", required: false, input: false },
        mustChangePassword: { type: "boolean", required: false, input: false },
        disabled: { type: "boolean", required: false, input: false },
      },
    },

    // the same list the CORS layer uses, so one config governs both
    trustedOrigins: corsAllowedOrigins,

    // Turns `authorization: bearer <token>` into a session, and hands a fresh
    // token back in the `set-auth-token` response header.
    // flow: header > before hook > session cookie > after hook > set-auth-token
    plugins: [bearer()],
  });

export type Auth = ReturnType<typeof createAuth>;

// One instance per database handle. betterAuth() does real setup work, and the
// middleware asks for an instance on every request.
const instances = new WeakMap<object, Auth>();

export const authFor = (database: DbOrTx = db): Auth => {
  const existing = instances.get(database);
  if (existing) return existing;

  const instance = createAuth(database);
  instances.set(database, instance);
  return instance;
};
