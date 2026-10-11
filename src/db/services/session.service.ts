import { db, type DbOrTx } from "../client";
import { notFound } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import { findProjectById } from "../repositories/project.repository";
import { writeAudit } from "./audit.service";
import {
  createSessionRecord,
  deleteSessionById,
  findSessionById,
  findSessionByProjectIdAndName,
  listSessionRecords,
  listSessionRecordsByIds,
  listSessionRecordsByProjectId,
  maxSessionDisplayNumberByProjectId,
  updateSessionById,
} from "../repositories/session.repository";
import { session } from "../schema";

export type CreateSessionInput = {
  projectId: number;
  name?: string | null;
};

const normalizeOptionalText = (value?: string | null) => {
  const trimmedValue = value?.trim();

  return trimmedValue ? trimmedValue : null;
};

const normalizeSessionUpdate = (
  data: Partial<typeof session.$inferInsert>,
): Partial<typeof session.$inferInsert> => {
  const nextData: Partial<typeof session.$inferInsert> = {};

  if ("projectId" in data) {
    nextData.projectId = data.projectId;
  }

  if ("name" in data) {
    nextData.name = normalizeOptionalText(data.name);
  }

  return nextData;
};

// Org scoping: a session hangs off a project, and the project carries the org.
// A session in another org reads as absent, never as forbidden.
const sessionInCallerOrg = async (
  sessionId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const row = await findSessionById(sessionId, database);
  if (!row) return null;
  if (!(await findProjectById(row.projectId, caller.organizationId, database))) return null;
  return row;
};

// display number: one more than the project's current max (spec). Concurrent
// inserts race on max+1; the uniq (project_id, display_number) index rejects
// the loser, which retries with a fresh max. A caller-supplied transaction
// gets a single attempt — a failed statement aborts that transaction.
// flow: project in org > ordinal > insert > audit
export const createSession = async (
  data: CreateSessionInput,
  caller: Caller,
  database?: DbOrTx,
) => {
  const insertOnce = async (dbOrTx: DbOrTx) => {
    if (!(await findProjectById(data.projectId, caller.organizationId, dbOrTx))) {
      throw notFound("Project");
    }

    const max = await maxSessionDisplayNumberByProjectId(data.projectId, dbOrTx);

    const created = await createSessionRecord(
      {
        projectId: data.projectId,
        name: normalizeOptionalText(data.name),
        displayNumber: (max ?? 0) + 1,
      },
      dbOrTx,
    );

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "create",
        resourceType: "Session",
        resourceId: created?.sessionId ?? null,
        after: created,
      },
      dbOrTx,
    );

    return created;
  };

  if (database) return insertOnce(database);

  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(insertOnce);
    } catch (err) {
      const lostRace =
        attempt < 2 && String(err).includes("uniq_session_project_display");
      if (!lostRace) throw err;
    }
  }
};

/* ---------- internal reads (no caller) ---------- */
// These serve the recording and inspection paths, whose ids came from a row the
// route already scoped. A route serving a client-supplied id uses the scoped
// readers above or below.
export const listSessions = async (database?: DbOrTx) =>
  listSessionRecords(database);

export const listSessionsByIds = async (
  sessionIds: number[],
  database?: DbOrTx,
) => listSessionRecordsByIds(sessionIds, database);

// flows a session id into the recording path, which has a deployment token
export const findSessionByIdInternal = async (
  sessionId: number,
  database?: DbOrTx,
) => findSessionById(sessionId, database);

// ponytail: the recording read routes carry no token yet, so this returns
// every org's sessions for a project id. It gets an org, and so does the rest
// of that feature, in the same change that guards /api/v1/recordings.
export const listSessionsByProjectIdInternal = async (
  projectId: number,
  database?: DbOrTx,
) => listSessionRecordsByProjectId(projectId, database);

export const listSessionsByProjectId = async (
  projectId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  // a project in another org has no sessions to show
  if (!(await findProjectById(projectId, caller.organizationId, database))) return [];
  return listSessionRecordsByProjectId(projectId, database);
};

export const getSessionById = async (
  sessionId: number,
  caller: Caller,
  database?: DbOrTx,
) => sessionInCallerOrg(sessionId, caller, database);

export const getSessionByProjectIdAndName = async (
  projectId: number,
  name: string,
  database?: DbOrTx,
) => {
  const normalizedName = normalizeOptionalText(name);

  if (normalizedName === null) {
    return null;
  }

  return findSessionByProjectIdAndName(projectId, normalizedName, database);
};

// flow: session in org > update > audit both versions, one transaction
// No lifecycle rule here by design: whoever holds `modify Session` may edit any
// session in the org. There is no owner check and no stuck-session override.
export const updateSession = async (
  sessionId: number,
  data: Partial<typeof session.$inferInsert>,
  caller: Caller,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const before = await sessionInCallerOrg(sessionId, caller, tx);
    if (!before) return null;

    const after = await updateSessionById(sessionId, normalizeSessionUpdate(data), tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "modify",
        resourceType: "Session",
        resourceId: sessionId,
        before,
        after,
      },
      tx,
    );

    return after;
  };

  return database ? run(database) : db.transaction(run);
};

export const deleteSession = async (
  sessionId: number,
  caller: Caller,
  database?: DbOrTx,
) => {
  const run = async (tx: DbOrTx) => {
    const before = await sessionInCallerOrg(sessionId, caller, tx);
    if (!before) return null;

    const deleted = await deleteSessionById(sessionId, tx);
    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "remove",
        resourceType: "Session",
        resourceId: sessionId,
        before,
      },
      tx,
    );

    return deleted;
  };

  return database ? run(database) : db.transaction(run);
};

