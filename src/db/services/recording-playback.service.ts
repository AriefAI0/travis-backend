// Scoped playback URLs for masters and clips.
// flow: playable ingest > first segment visible > scoped token > relative path
//
// The URL is relative on purpose: the client joins it with the same backend
// base it used for this read, which is the only address that reaches us.

import type { DbOrTx } from "../client";
import { mintPlaybackToken, type PlaybackScope } from "../../lib/playback_token";
import {
  findIngestSegmentRecord,
  findPlayableIngestRecord,
  listFirstSegmentIngestIds,
  listIngestRecordsByClipIds,
} from "../repositories/recording-ingest.repository";
import type { recordingIngest } from "../schema";

// the frozen range and the contiguous prefix both bound what a token may reach
export const lastPlayableSequence = (ingest: typeof recordingIngest.$inferSelect): number =>
  ingest.closedAt === null ? ingest.contiguousSequence : (ingest.finalSequence ?? -1);

// a recording plays once segment zero is inside its visible range
export const hasPlayableFirstSegment = async (
  scope: PlaybackScope,
  database?: DbOrTx,
): Promise<boolean> => {
  const ingest = await findPlayableIngestRecord(scope, database);
  if (!ingest || lastPlayableSequence(ingest) < 0) return false;
  return (await findIngestSegmentRecord(ingest.ingestId, 0, database)) !== null;
};

// pure builder: token plus path, no database work
export const playbackUrl = (scope: PlaybackScope): string => {
  const token = encodeURIComponent(mintPlaybackToken(scope));
  return `/api/v2/hls/${scope.kind}/${scope.id}/index.m3u8?t=${token}`;
};

export const mintRecordingPlaybackUrl = async (
  scope: PlaybackScope,
  database?: DbOrTx,
): Promise<string | null> =>
  (await hasPlayableFirstSegment(scope, database)) ? playbackUrl(scope) : null;

// batched twin for list reads: two queries for any number of clips, never one per row
export const listPlayableClipIds = async (
  clipIds: number[],
  database?: DbOrTx,
): Promise<Set<number>> => {
  if (clipIds.length === 0) return new Set();

  const ingestRows = await listIngestRecordsByClipIds(clipIds, database);
  // the first row per clip wins: open first, then the newest closed
  const playableIngestByClip = new Map<number, (typeof ingestRows)[number]>();
  for (const row of ingestRows) {
    const clipId = row.clipId!;
    if (playableIngestByClip.has(clipId)) continue;
    playableIngestByClip.set(clipId, row);
  }

  const candidates = [...playableIngestByClip.values()].filter(
    (row) => lastPlayableSequence(row) >= 0,
  );
  if (candidates.length === 0) return new Set();

  const withFirstSegment = new Set(
    await listFirstSegmentIngestIds(
      candidates.map((row) => row.ingestId),
      database,
    ),
  );
  return new Set(
    candidates
      .filter((row) => withFirstSegment.has(row.ingestId))
      .map((row) => row.clipId!),
  );
};

export const mintMasterPlaybackUrl = (masterVideoId: number, database?: DbOrTx) =>
  mintRecordingPlaybackUrl({ kind: "master", id: masterVideoId }, database);

export const mintClipPlaybackUrl = (clipId: number, database?: DbOrTx) =>
  mintRecordingPlaybackUrl({ kind: "clip", id: clipId }, database);
