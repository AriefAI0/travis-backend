import { and, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingDiscardAudit } from "../schema";

// insert one audited discard; no-op when the request was already audited
export const insertRecordingDiscardAudit = async (
  data: typeof recordingDiscardAudit.$inferInsert,
  database: DbOrTx = db,
) => {
  const inserted = await database
    .insert(recordingDiscardAudit)
    .values(data)
    .onConflictDoNothing({
      target: [recordingDiscardAudit.requestId, recordingDiscardAudit.recordingId],
    })
    .returning();
  return inserted[0] ?? null;
};

// find one audit row by request + recording, or null (directive replay check)
export const findRecordingDiscardAudit = async (
  requestId: string,
  recordingId: string,
  database: DbOrTx = db,
) =>
  (await database.query.recordingDiscardAudit.findFirst({
    where: and(
      eq(recordingDiscardAudit.requestId, requestId),
      eq(recordingDiscardAudit.recordingId, recordingId)
    ),
  })) ?? null;
