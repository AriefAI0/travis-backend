import { Hono } from "hono";
import type { DbOrTx } from "../../src/db/client";
import { onError } from "../../src/lib/error";

type Factory = (database?: DbOrTx) => Hono;

// route harness: factories on testDb + central onError (HTTP seam only)
export const appFor = (database: DbOrTx, ...factories: Factory[]) => {
  const app = new Hono();
  app.onError(onError);
  for (const factory of factories) app.route("/", factory(database));
  return app;
};
