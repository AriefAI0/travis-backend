// Crash recovery for direct ingest: a capture that stops talking closes itself.
// flow: every 2 s > pick idle rows > close each on its own row lock

import { and, isNull, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { log } from "../../lib/logger";
import { recordingIngest } from "../../db/schema";
import { closeIdleIngest, INGEST_IDLE_CLOSE_MS } from "./ingest-service";

export const INGEST_SWEEP_INTERVAL_MS = 2_000;

// close every ingest that stayed silent past the idle cutoff; returns their ids
export const sweepInactiveIngests = async (
  now: Date = new Date(),
  database: DbOrTx = db,
): Promise<number[]> => {
  const cutoff = new Date(now.getTime() - INGEST_IDLE_CLOSE_MS);

  // openedAt covers an ingest that never stored a segment
  const idleSince = sql`COALESCE(${recordingIngest.lastSegmentAt}, ${recordingIngest.openedAt})`;
  const candidates = await database
    .select({ ingestId: recordingIngest.ingestId })
    .from(recordingIngest)
    .where(and(isNull(recordingIngest.closedAt), lte(idleSince, cutoff)));

  const closed: number[] = [];
  for (const { ingestId } of candidates) {
    // a late segment leaves the row open; the lock decides, never this read
    const result = await closeIdleIngest(ingestId, cutoff, database);
    if (result) closed.push(ingestId);
  }
  return closed;
};

// boot timer; one failed pass never stops the next
export const startIngestSweep = (intervalMs: number = INGEST_SWEEP_INTERVAL_MS) => {
  const timer = setInterval(() => {
    void sweepInactiveIngests().catch((err) =>
      log.error("ingest sweep failed", { err: String(err) }),
    );
  }, intervalMs);
  timer.unref?.();
  return timer;
};
