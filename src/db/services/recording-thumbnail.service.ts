// Everything a thumbnail job needs to know, and the one place its rows land.
// The job itself only runs FFmpeg and moves bytes; the decisions live here.

import type { DbOrTx } from "../client";
import { db } from "../client";
import { findMasterVideoById } from "../repositories/master-video.repository";
import {
  listIngestSegmentRecords,
  findPlayableIngestRecord,
} from "../repositories/recording-ingest.repository";
import {
  createMasterVideoTimelineThumbnailRecords,
  listMasterVideoIdsMissingTimelineThumbnails,
} from "../repositories/timeline-thumbnail.repository";
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
  masterVideoId: number;
  // Frozen at admission: a rename never moves a still to a second directory.
  keyPrefix: string;
  durationMs: number;
  // Sealed segments in sequence order, contiguous prefix only.
  segments: ThumbnailSegment[];
};

// Closed masters with no timeline rows: the boot scan's whole signal.
export const listMastersNeedingThumbnails = (database?: DbOrTx): Promise<number[]> =>
  listMasterVideoIdsMissingTimelineThumbnails(database ?? db);

// flow: master > closed ingest > frozen key prefix > sealed segments
export const loadThumbnailSource = async (
  masterVideoId: number,
  database?: DbOrTx,
): Promise<ThumbnailSource | null> => {
  const handle = database ?? db;

  const master = await findMasterVideoById(masterVideoId, handle);
  if (!master) return null;

  // The closed ingest holds the key prefix and the segments this master owns.
  const ingest = await findPlayableIngestRecord({ kind: "master", id: masterVideoId }, handle);
  if (!ingest) return null;

  const rows = await listIngestSegmentRecords(ingest.ingestId, null, handle);
  if (rows.length === 0) return null;

  return {
    masterVideoId,
    // read, never re-derived: the live project title may have changed since
    keyPrefix: ingest.keyPrefix,
    durationMs: rows.reduce((total, row) => total + row.durationMs, 0),
    segments: rows.map((row) => ({
      sequence: row.sequence,
      objectKey: row.objectKey,
      durationMs: row.durationMs,
    })),
  };
};

// Rows land in one insert, after every still is stored. A run that dies early
// therefore leaves no rows, which is exactly what the boot scan looks for.
export const recordTimelineThumbnails = async (
  rows: TimelineThumbnailInsert[],
  database?: DbOrTx,
): Promise<number> => {
  if (rows.length === 0) return 0;
  const created = await createMasterVideoTimelineThumbnailRecords(rows, database ?? db);
  return created.length;
};
