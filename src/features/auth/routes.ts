import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { AUTH_BASE_PATH, createAuth } from "../../lib/auth/auth";

// The better-auth surface: sign-in, sign-out, session read.
// flow: mount base path > better-auth handles it > its own response
// No requireUser here — this is where a token comes from in the first place.
export const authRoutes = (database?: DbOrTx) => {
  const app = new Hono();
  const auth = createAuth(database);

  app.on(["POST", "GET"], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw));

  return app;
};
