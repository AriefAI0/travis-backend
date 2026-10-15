import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { db } from "../../db/client";
import { emailByUsername } from "../../db/repositories/user.repository";
import { AUTH_BASE_PATH, createAuth } from "../../lib/auth/auth";

// The three headers a browser adds to say where a request came from.
const FETCH_METADATA = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];

// Electron's main-process fetch sends `sec-fetch-mode: cors` and no Origin.
// better-auth reads any sec-fetch-* header as "this is a browser", then demands
// a trusted Origin and refuses the sign-in with MISSING_OR_NULL_ORIGIN. That
// blocked every desktop sign-in.
//
// This backend serves a desktop client, so those headers say nothing here.
// Removing them leaves the Origin check in charge: a browser still sends
// Origin, so its cross-site refusals stand.
export const withoutFetchMetadata = (request: Request): Request => {
  if (!FETCH_METADATA.some((name) => request.headers.has(name))) return request;

  const headers = new Headers(request.headers);
  for (const name of FETCH_METADATA) headers.delete(name);

  return new Request(request, { headers });
};

// flow: identifier with no @ > username lookup > swap in the real email
// The form sends one field in `email`. An email goes straight through; any
// other string is looked up as a username, and only a match rewrites the body.
// An unmatched name falls through, so better-auth answers it as a wrong login.
const withLoginResolved = async (
  request: Request,
  database: DbOrTx,
): Promise<Request> => {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;

  // Reading the body consumed it, so every path below rebuilds the request.
  // Headers pass through by hand: the Origin must survive, or a browser's
  // refusal stops working.
  const rebuild = (email?: string): Request =>
    new Request(request, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(email === undefined ? body : { ...body, email }),
    });

  if (typeof body?.email !== "string" || body.email.includes("@")) return rebuild();

  const email = await emailByUsername(body.email.trim(), database);
  return rebuild(email ?? undefined);
};

// The better-auth surface: sign-in, sign-out, session read.
// flow: mount base path > resolve the login handle > drop the browser metadata
// No requireUser here — this is where a token comes from in the first place.
export const authRoutes = (database?: DbOrTx) => {
  const app = new Hono();
  const auth = createAuth(database);
  const handle = database ?? db;

  // Registered before the catch-all, so the exact path wins over the wildcard.
  app.on("POST", `${AUTH_BASE_PATH}/sign-in/email`, async (c) =>
    auth.handler(withoutFetchMetadata(await withLoginResolved(c.req.raw, handle))),
  );

  app.on(["POST", "GET"], `${AUTH_BASE_PATH}/*`, (c) =>
    auth.handler(withoutFetchMetadata(c.req.raw)),
  );

  return app;
};
