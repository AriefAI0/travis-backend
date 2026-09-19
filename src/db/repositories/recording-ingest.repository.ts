// Data access for the direct ingest ledger. The playlist reader and the
// playback-URL minter share these reads, so the visibility rule lives once.

import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { recordingIngest, recordingIngestSegment } from "../schema";

export type IngestScope = { kind: "master" | "clip"; id: number };

// the playable ingest of a recording: a live one wins, else the newest closed
export const findPlayableIngestRecord = async (
  scope: IngestScope,
  database: DbOrTx = db,
) =>
  (await database
    .select()
    .from(recordingIngest)
    .where(
      scope.kind === "master"
        ? eq(recordingIngest.masterVideoId, scope.id)
        : eq(recordingIngest.clipId, scope.id),
    )
    .orderBy(sql`${recordingIngest.closedAt} IS NULL DESC`, desc(recordingIngest.ingestId))
    .limit(1))[0] ?? null;

// every ingest row of many clips, newest first, for batched playability reads
export const listIngestRecordsByClipIds = async (
  clipIds: number[],
  database: DbOrTx = db,
) =>
  database
    .select()
    .from(recordingIngest)
    .where(inArray(recordingIngest.clipId, clipIds))
    .orderBy(sql`${recordingIngest.closedAt} IS NULL DESC`, desc(recordingIngest.ingestId));

// the ingest ids that hold a stored segment zero, in one query
export const listFirstSegmentIngestIds = async (
  ingestIds: number[],
  database: DbOrTx = db,
): Promise<number[]> =>
  (
    await database
      .select({ ingestId: recordingIngestSegment.ingestId })
      .from(recordingIngestSegment)
      .where(
        and(
          inArray(recordingIngestSegment.ingestId, ingestIds),
          eq(recordingIngestSegment.sequence, 0),
        ),
      )
  ).map((row) => row.ingestId);

// segment rows ascending, optionally capped at a frozen sequence
export const listIngestSegmentRecords = async (
  ingestId: number,
  upToSequence: number | null,
  database: DbOrTx = db,
) =>
  database
    .select({
      sequence: recordingIngestSegment.sequence,
      durationMs: recordingIngestSegment.durationMs,
      discontinuity: recordingIngestSegment.discontinuity,
      objectKey: recordingIngestSegment.objectKey,
    })
    .from(recordingIngestSegment)
    .where(
      upToSequence === null
        ? eq(recordingIngestSegment.ingestId, ingestId)
        : and(
            eq(recordingIngestSegment.ingestId, ingestId),
            lte(recordingIngestSegment.sequence, upToSequence),
          ),
    )
    .orderBy(asc(recordingIngestSegment.sequence));

export const findIngestSegmentRecord = async (
  ingestId: number,
  sequence: number,
  database: DbOrTx = db,
) =>
  (await database
    .select({
      sequence: recordingIngestSegment.sequence,
      objectKey: recordingIngestSegment.objectKey,
    })
    .from(recordingIngestSegment)
    .where(
      and(
        eq(recordingIngestSegment.ingestId, ingestId),
        eq(recordingIngestSegment.sequence, sequence),
      ),
    )
    .limit(1))[0] ?? null;
