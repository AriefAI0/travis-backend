import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { DbOrTx } from "../../db/client";
import { listPermissionsByUser } from "../../db/repositories/user-permission.repository";
import { buildAbility, type AppAbility } from "../../lib/auth/ability";
import { requireUser, type AuthVariables } from "../../lib/auth/middleware";
import type { Subject } from "../../lib/auth/permissions";
import { log } from "../../lib/logger";
import { subscribe, type ChangeEvent } from "../../lib/events/bus";

// The change stream. One SSE stream per signed-in client.
//
// flow: requireUser > subscribe(org) > one event > rights check > writeSSE
//
// The org is applied by the bus, so nothing crosses a tenant. Rights are
// re-read per event rather than taken from the request's ability: a stream
// outlives a request, and a revoke has to bite on the next event, not on the
// next reconnect.
const PREFIX = "/api/v1/events";

// How often the loop looks for a queued event, and how often it writes a
// keep-alive so a proxy does not close an idle stream.
const POLL_MS = 1_000;
const KEEP_ALIVE_MS = 25_000;

// The audit row's word for a resource > the subject its readers must hold.
// Keyed in lower case: the writers are not consistent — projects audit as
// "Project" and the archive as "project" — so the lookup folds case.
// A type outside this map is withheld: a new resource that nobody thought
// about must not leak by default.
const SUBJECT_OF: Record<string, Subject> = {
  project: "Project",
  session: "Session",
  result: "Result",
  resultimage: "Result",
  recording: "Recording",
  report: "Report",
  taskgroup: "Structure",
  taskcode: "Structure",
  description: "Structure",
  type: "Structure",
  partcode: "Structure",
  user: "User",
  permission: "Permission",
  auditlog: "AuditLog",
};

// The account a change concerns. The audit row's userId is the ACTOR, so the
// subject of an account change is the row's target: an account row whose id is
// this caller's.
const isAboutMe = (event: ChangeEvent, userId: string): boolean =>
  event.resourceId === userId &&
  (event.resourceType.toLowerCase() === "user" ||
    event.resourceType.toLowerCase() === "permission");

// flow: is it about me? tell me : do I hold read on its subject
// A change to the caller's own account always arrives: a user must learn that
// their rights moved, or they keep working against a stale view.
const isVisible = (ability: AppAbility, event: ChangeEvent, userId: string): boolean => {
  if (isAboutMe(event, userId)) {
    return true;
  }

  const subject = SUBJECT_OF[event.resourceType.toLowerCase()];
  return subject !== undefined && ability.can("read", subject);
};

// A one-shot signal, so a queued event wakes the loop at once rather than on
// the next poll.
const waiter = () => {
  let wake: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    wake = resolve;
  });

  return { promise, wake };
};

export const eventRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // This feature's own prefix, never "*": a sub-app mounted at "/" has its
  // wildcard middleware merged at the mount prefix.
  routes.use(PREFIX, requireUser(database));

  routes.get(PREFIX, async (c) => {
    const user = c.get("user");
    const { organizationId, userId } = user;

    return streamSSE(c, async (stream) => {
      const queue: ChangeEvent[] = [];
      let wake: (() => void) | null = null;

      const unsubscribe = subscribe(organizationId, (event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(unsubscribe);

      let idleMs = 0;

      try {
        while (!stream.aborted) {
          const event = queue.shift();

          if (event) {
            idleMs = 0;

            // Read the rows now: a revoked right withholds this event.
            const ability = buildAbility(await listPermissionsByUser(userId, database));
            if (isVisible(ability, event, userId)) {
              await stream.writeSSE({
                event: "change",
                id: String(event.id),
                data: JSON.stringify(event),
              });
            }

            continue;
          }

          const next = waiter();
          wake = next.wake;

          await Promise.race([next.promise, stream.sleep(POLL_MS)]);
          wake = null;

          idleMs += POLL_MS;
          if (idleMs >= KEEP_ALIVE_MS) {
            idleMs = 0;
            await stream.write(": keep-alive\n\n");
          }
        }
      } catch (error) {
        // A client that goes away aborts the stream, which is normal. Anything
        // else has to be visible, or the stream just goes quiet.
        if (!stream.aborted) {
          log.warn("change stream ended early", { userId, error: String(error) });
        }
        return;
      } finally {
        unsubscribe();
        if (stream.closed) await stream.close();
      }
    });
  });

  return routes;
};
