// Everything a thumbnail job needs to know, and the one place its rows land.
// The job itself only runs FFmpeg and moves bytes; the decisions live here.

import type { DbOrTx } from "../client";
import { db } from "../client";
import { findSessionById } from "../repositories/session.repository";
import {
  listIngestSegmentRecords,
  findPlayableIngestRecord,
} from "../repositories/recording-ingest.repository";
import {
  createTimelineThumbnailRecords,
  listSessionIdsWithThumbnailWork,
  listTimelineThumbnailTimestampsBySessionId,
} from "../repositories/timeline-thumbnail.repository";
import {
  listClipIdsWithThumbnailWork,
  updateVideoClipById,
} from "../repositories/video-clip.repository";
import type { timelineThumbnail } from "../schema";

// One sealed segment a thumbnail run may read.
export type ThumbnailSegment = {
  sequence: number;
  objectKey: string;
  durationMs: number;
};

// The row shape a thumbnail run writes. Exported so the job never reaches for
// the schema itself: features read services, not tables.
export type TimelineThumbnailInsert = typeof timelineThumbnail.$inferInsert;

export type ThumbnailSource = {
  sessionId: number;
  // Frozen at admission: a rename never moves a still to a second directory.
  keyPrefix: string;
  durationMs: number;
  // Closed ingests freeze a range and take the poster; an open one keeps
  // growing, so a run only fills grid points.
  closed: boolean;
  // Grid points that already have a still: what a re-run must not repeat.
  existingTimestamps: number[];
  // Sealed segments in sequence order, contiguous prefix only.
  segments: ThumbnailSegment[];
};

// One clip still: the first playable segment and where its object belongs.
export type ClipStillSource = {
  clipId: number;
  keyPrefix: string;
  firstSegmentObjectKey: string;
};

// A hole ends the prefix: stills past it would sit at the wrong offset.
const contiguousRows = <Row extends { sequence: number }>(rows: Row[]): Row[] => {
  const prefix: Row[] = [];
  let expected = 0;
  for (const row of rows) {
    if (row.sequence !== expected) break;
    prefix.push(row);
    expected += 1;
  }
  return prefix;
};

// Sessions whose grid may be short: still recording, or never thumbnailed.
// The job decides what is due, so a covered session reports nothing.
export const listMastersNeedingThumbnails = (database?: DbOrTx): Promise<number[]> =>
  listSessionIdsWithThumbnailWork(database ?? db);

// Clips holding segments with no still yet.
export const listClipsNeedingThumbnails = (database?: DbOrTx): Promise<number[]> =>
  listClipIdsWithThumbnailWork(database ?? db);

// flow: session > playable ingest > frozen key prefix > sealed segments
export const loadThumbnailSource = async (
  sessionId: number,
  database?: DbOrTx,
): Promise<ThumbnailSource | null> => {
  const handle = database ?? db;

  const session = await findSessionById(sessionId, handle);
  if (!session) return null;

  // The ingest holds the key prefix and the segments this master owns.
  const ingest = await findPlayableIngestRecord({ kind: "master", id: sessionId }, handle);
  if (!ingest) return null;

  const rows = contiguousRows(await listIngestSegmentRecords(ingest.ingestId, null, handle));
  if (rows.length === 0) return null;

  return {
    sessionId,
    // read, never re-derived: the live project title may have changed since
    keyPrefix: ingest.keyPrefix,
    durationMs: rows.reduce((total, row) => total + row.durationMs, 0),
    closed: ingest.closedAt !== null,
    existingTimestamps: await listTimelineThumbnailTimestampsBySessionId(
      sessionId,
      handle,
    ),
    segments: rows.map((row) => ({
      sequence: row.sequence,
      objectKey: row.objectKey,
      durationMs: row.durationMs,
    })),
  };
};

// flow: clip > playable ingest > frozen key prefix > first sealed segment
export const loadClipStillSource = async (
  clipId: number,
  database?: DbOrTx,
): Promise<ClipStillSource | null> => {
  const handle = database ?? db;

  const ingest = await findPlayableIngestRecord({ kind: "clip", id: clipId }, handle);
  if (!ingest) return null;

  const rows = contiguousRows(await listIngestSegmentRecords(ingest.ingestId, null, handle));
  const first = rows[0];
  if (!first) return null;

  return {
    clipId,
    keyPrefix: ingest.keyPrefix,
    firstSegmentObjectKey: first.objectKey,
  };
};

// Rows land in one insert, after every still is stored. A run that dies early
// therefore leaves no rows, which is exactly what the boot scan looks for.
export const recordTimelineThumbnails = async (
  rows: TimelineThumbnailInsert[],
  database?: DbOrTx,
): Promise<number> => {
  if (rows.length === 0) return 0;
  const created = await createTimelineThumbnailRecords(rows, database ?? db);
  return created.length;
};

// The clip still is one key on the clip row; null means it has not run.
export const recordClipStill = async (
  clipId: number,
  thumbnailKey: string,
  database?: DbOrTx,
): Promise<void> => {
  await updateVideoClipById(clipId, { thumbnailKey }, database ?? db);
};
