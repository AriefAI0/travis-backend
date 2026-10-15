// Crash recovery for direct ingest: a capture that stops talking closes itself.
// flow: every 2 s > pick idle rows per tier > close each on its own row lock

import { and, isNull, isNotNull, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../../db/client";
import { log } from "../../lib/logger";
import { recordingIngest } from "../../db/schema";
import { INGEST_RECOVERY_GRACE_MS } from "../../lib/ingest_lease";
import { closeIdleIngest, INGEST_IDLE_CLOSE_MS } from "./ingest-service";

export const INGEST_SWEEP_INTERVAL_MS = 2_000;

// close every ingest that stayed silent past its tier's idle cutoff; returns
// their ids. Empty ingests close at the idle window; an ingest with committed
// footage gets the recovery grace so a restarted app can rebind and drain.
export const sweepInactiveIngests = async (
  now: Date = new Date(),
  database: DbOrTx = db,
): Promise<number[]> => {
  const tiers = [
    {
      cutoff: new Date(now.getTime() - INGEST_IDLE_CLOSE_MS),
      hasSegments: false,
    },
    {
      cutoff: new Date(now.getTime() - INGEST_RECOVERY_GRACE_MS),
      hasSegments: true,
    },
  ];

  // openedAt covers an ingest that never stored a segment; the heartbeat keeps
  // a live-but-paused capture out of this list. GREATEST skips NULLs.
  const idleSince = sql`GREATEST(${recordingIngest.openedAt}, ${recordingIngest.lastSegmentAt}, ${recordingIngest.lastSeenAt})`;

  const closed: number[] = [];
  for (const { cutoff, hasSegments } of tiers) {
    const candidates = await database
      .select({ ingestId: recordingIngest.ingestId })
      .from(recordingIngest)
      .where(
        and(
          isNull(recordingIngest.closedAt),
          hasSegments
            ? isNotNull(recordingIngest.lastSegmentAt)
            : isNull(recordingIngest.lastSegmentAt),
          lte(idleSince, cutoff),
        ),
      );

    for (const { ingestId } of candidates) {
      // a late segment leaves the row open; the lock decides, never this read
      const result = await closeIdleIngest(ingestId, cutoff, database);
      if (result) closed.push(ingestId);
    }
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
