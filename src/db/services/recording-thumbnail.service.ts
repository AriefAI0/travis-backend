// Everything a thumbnail job needs to know, and the one place its rows land.
// The job itself only runs FFmpeg and moves bytes; the decisions live here.

import type { DbOrTx } from "../client";
import { db } from "../client";
import { resolveOrganizationId, type MediaScope } from "../../lib/minio_storage/paths";
import { findMasterVideoById } from "../repositories/master-video.repository";
import { findProjectById } from "../repositories/project.repository";
import { findSessionById } from "../repositories/session.repository";
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

export type ThumbnailSource = {
  masterVideoId: number;
  scope: MediaScope;
  durationMs: number;
  // Sealed segments in sequence order, contiguous prefix only.
  segments: ThumbnailSegment[];
};

// Closed masters with no timeline rows: the boot scan's whole signal.
export const listMastersNeedingThumbnails = (database?: DbOrTx): Promise<number[]> =>
  listMasterVideoIdsMissingTimelineThumbnails(database ?? db);

// flow: master > session > project > org > key date > sealed segments
export const loadThumbnailSource = async (
  masterVideoId: number,
  database?: DbOrTx,
): Promise<ThumbnailSource | null> => {
  const handle = database ?? db;

  const master = await findMasterVideoById(masterVideoId, handle);
  if (!master) return null;

  const session = await findSessionById(master.sessionId, handle);
  if (!session) return null;

  const project = await findProjectById(session.projectId, handle);
  if (!project) return null;

  // The closed ingest holds the key date and the segments this master owns.
  const ingest = await findPlayableIngestRecord({ kind: "master", id: masterVideoId }, handle);
  if (!ingest) return null;

  const rows = await listIngestSegmentRecords(ingest.ingestId, null, handle);
  if (rows.length === 0) return null;

  return {
    masterVideoId,
    scope: {
      organizationId: await resolveOrganizationId(project.organizationId, handle),
      projectId: project.projectId,
      sessionId: session.sessionId,
      // the ingest row froze the key date at admission
      startedAt: new Date(`${ingest.keyDate}T00:00:00.000Z`),
    },
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
  rows: (typeof timelineThumbnail.$inferInsert)[],
  database?: DbOrTx,
): Promise<number> => {
  if (rows.length === 0) return 0;
  const created = await createMasterVideoTimelineThumbnailRecords(rows, database ?? db);
  return created.length;
};
