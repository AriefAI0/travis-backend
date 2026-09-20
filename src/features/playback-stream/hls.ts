// Dynamic HLS from stored segment rows: no stored manifest, no FFmpeg.
// flow: read snapshot > walk the contiguous prefix > render
//
// The playlist is rebuilt on every request. A closed recording is a VOD range;
// a capture that is still running is an EVENT playlist that keeps growing, so
// earlier footage stays seekable for as long as the recording lasts.

import type { DbOrTx } from "../../db/client";
import { notFound } from "../../lib/error";
import type { PlaybackScope } from "../../lib/playback_token";
import {
  findIngestSegmentRecord,
  findPlayableIngestRecord,
  listIngestSegmentRecords,
} from "../../db/repositories/recording-ingest.repository";
import { lastPlayableSequence } from "../../db/services/recording-playback.service";

export type PlaylistSegment = {
  sequence: number;
  durationMs: number;
  discontinuity: boolean;
};

export type PlaylistSource = {
  // every entry to render, ascending, already gapless from sequence zero
  segments: PlaylistSegment[];
  closed: boolean;
  mediaSequence: number;
  targetDurationSeconds: number;
};

// the prefix stops at the first hole; stragglers past it stay hidden
export function contiguousPrefix(rows: PlaylistSegment[]): PlaylistSegment[] {
  const prefix: PlaylistSegment[] = [];
  let expected = 0;
  for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
    if (row.sequence !== expected) break;
    prefix.push(row);
    expected += 1;
  }
  return prefix;
}

// ceil to whole seconds: the spec wants the longest entry, rounded up
export function targetDurationSeconds(segments: PlaylistSegment[]): number {
  const longest = segments.reduce((max, row) => Math.max(max, row.durationMs), 0);
  return Math.max(1, Math.ceil(longest / 1000));
}

const extinf = (durationMs: number): string => (durationMs / 1000).toFixed(3);

// render one playlist; segmentUri returns the absolute or relative child URL
export function buildPlaylist(source: PlaylistSource, segmentUri: (sequence: number) => string): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${source.targetDurationSeconds}`,
    `#EXT-X-MEDIA-SEQUENCE:${source.mediaSequence}`,
    // EVENT: append-only, so a player keeps every listed segment seekable and
    // holds the media sequence at zero for the whole capture.
    source.closed ? "#EXT-X-PLAYLIST-TYPE:VOD" : "#EXT-X-PLAYLIST-TYPE:EVENT",
  ];

  for (const segment of source.segments) {
    if (segment.discontinuity) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${extinf(segment.durationMs)},`, segmentUri(segment.sequence));
  }

  if (source.closed) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

// read the pointer and the rows, then derive the range from the rows alone
export const readPlaylistSource = async (
  scope: PlaybackScope,
  database?: DbOrTx,
): Promise<PlaylistSource> => {
  const ingest = await findPlayableIngestRecord(scope, database);
  if (!ingest) throw notFound("Ingest");

  // a closed ingest hides everything beyond its frozen range
  const visibleEnd = ingest.closedAt === null ? null : (ingest.finalSequence ?? -1);
  const rows = await listIngestSegmentRecords(ingest.ingestId, visibleEnd, database);

  const segments = contiguousPrefix(rows);
  const closed = ingest.closedAt !== null;

  return {
    segments,
    closed,
    // fixed at zero: an EVENT playlist never renumbers what it already served
    mediaSequence: 0,
    targetDurationSeconds: targetDurationSeconds(segments),
  };
};

// one stored object, resolved from the requested sequence alone — never a scan
export const findPlayableSegment = async (
  scope: PlaybackScope,
  sequence: number,
  database?: DbOrTx,
): Promise<{ sequence: number; objectKey: string } | null> => {
  const ingest = await findPlayableIngestRecord(scope, database);
  if (!ingest) return null;
  if (sequence < 0 || sequence > lastPlayableSequence(ingest)) return null;

  return findIngestSegmentRecord(ingest.ingestId, sequence, database);
};
