import { Hono } from "hono";

import type { DbOrTx } from "../../db/client";
import { requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import {
  ACTIONS,
  GRANTABLE,
  STRUCTURE_LEVELS,
  SUBJECTS,
} from "../../lib/auth/permissions";
import { PRESET_NAMES, presetRows } from "../../lib/auth/presets";
import { ok } from "../../lib/response";

// The permission vocabulary, served to the admin UI.
//
// Why a route rather than a copy in the renderer: the tick grid must offer
// exactly the pairs the backend accepts. A hand-copied table drifts, and the
// drift shows up as a 400 on save. This is the same module the middleware
// checks against, so the two cannot disagree.
//
// flow: requireUser > requireCan > vocabularies > ok
const PREFIX = "/api/v1/permissions";

export const permissionRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use(PREFIX, requireUser(database));
  routes.use(`${PREFIX}/*`, requireUser(database));

  // Only an account that may edit permissions needs the grid.
  routes.get(`${PREFIX}/catalog`, requireCan("manage", "Permission"), async (c) =>
    ok(c, {
      actions: ACTIONS,
      subjects: SUBJECTS,
      structureLevels: STRUCTURE_LEVELS,
      // action > the subjects it may be granted on
      grantable: GRANTABLE,
      presets: Object.fromEntries(
        PRESET_NAMES.map((name) => [name, presetRows(name)]),
      ),
    }),
  );

  return routes;
};
