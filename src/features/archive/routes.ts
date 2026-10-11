import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  ARCHIVE,
  archiveRow,
  isArchiveResource,
  listArchive,
  removeArchived,
  removalCounts,
  restoreRow,
} from "../../db/services/archive.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { AppError } from "../../lib/error";
import { parseId, parseQuery } from "../../lib/parse";
import { ok } from "../../lib/response";
import { archiveQuerySchema } from "../../types/api";

// Archive, restore, and permanent removal.
// flow: requireUser > requireCan > archive.service > ok
//
// `result` is not a resource here. It carries `archivedAt`, so a generic
// handler would accept it, but a result is removed directly with its evidence.
//
// Only /api/v1/archive is this feature's own prefix. Archive and restore are
// reached as /api/v1/<resource>/<id>/archive, which shares the root with every
// other feature, so those two take their guard inline.
export const archiveRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  routes.use("/api/v1/archive", requireUser(database));
  routes.use("/api/v1/archive/*", requireUser(database));

  // A resource outside the allow-list is not a route. The check runs before the
  // org lookup, so a probing request learns nothing about any row.
  const resourceOf = (raw: string) => {
    if (!isArchiveResource(raw)) {
      throw new AppError(404, "not_found", `Resource ${raw} is not archivable`);
    }
    return raw;
  };

  // flow: resource > node and its descendants > stamp > ok
  routes.post(
    "/api/v1/:resource/:id/archive",
    requireUser(database),
    async (c, next) => {
      const resource = resourceOf(c.req.param("resource"));
      return requireCan("modify", ARCHIVE[resource].subject)(c, next);
    },
    async (c) => {
      const resource = resourceOf(c.req.param("resource"));
      const tree = await archiveRow(resource, parseId(c, "id"), callerOf(c), database);
      return ok(c, { resource, archived: tree[resource] ?? [] });
    },
  );

  routes.post(
    "/api/v1/:resource/:id/restore",
    requireUser(database),
    async (c, next) => {
      const resource = resourceOf(c.req.param("resource"));
      return requireCan("restore", ARCHIVE[resource].subject)(c, next);
    },
    async (c) => {
      const resource = resourceOf(c.req.param("resource"));
      const tree = await restoreRow(resource, parseId(c, "id"), callerOf(c), database);
      return ok(c, { resource, restored: tree[resource] ?? [] });
    },
  );

  // The archive page: one resource, or every one the caller may read. The
  // ability decides per resource, because the list mixes subjects.
  routes.get("/api/v1/archive", async (c) => {
    const query = parseQuery(c, archiveQuerySchema);
    const ability = c.get("ability");

    return ok(
      c,
      await listArchive(query, (subject) => ability.can("read", subject), database),
    );
  });

  // Permanent removal. `?dryRun=true` answers the same counts and deletes
  // nothing, so the confirm dialog reads the same walk the delete runs.
  routes.delete("/api/v1/archive/:resource/:id", async (c, next) => {
    const resource = resourceOf(c.req.param("resource"));
    return requireCan("remove", ARCHIVE[resource].subject)(c, next);
  }, async (c) => {
    const resource = resourceOf(c.req.param("resource"));
    const id = parseId(c, "id");
    const caller = callerOf(c);

    if (c.req.query("dryRun") === "true") {
      return ok(c, { resource, counts: await removalCounts(resource, id, caller, database) });
    }

    return ok(c, { resource, counts: await removeArchived(resource, id, caller, database) });
  });

  return routes;
};
