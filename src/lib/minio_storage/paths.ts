// The ONE place app identity becomes bucket+key pairs (spec: path module owns
// every leaf). flow: identity > stem > leaf pairs; no key literal anywhere else.

import { env } from "../../config/env";
import type { DbOrTx } from "../../db/client";
import { ensureDefaultOrganization } from "../../db/ensure-org";
import { AppError } from "../error";
import type { InspectionTypeCode } from "../../types/api";

export interface Leaf {
  bucket: string;
  key: string;
}

export interface MasterIdentity {
  kind: "master";
  projectId: number;
  sessionId: number;
  recordingId: number;
}

export interface ClipIdentity {
  kind: "clip";
  projectId: number;
  sessionId: number;
  itemId: number;
  clipId: number;
}

export type RecordingIdentity = MasterIdentity | ClipIdentity;

// canonical uniqueness string — stored in tracker identity_string column
export function identityString(id: RecordingIdentity): string {
  if (id.kind === "master") return `p${id.projectId}-s${id.sessionId}-r${id.recordingId}`;
  return `p${id.projectId}-s${id.sessionId}-i${id.itemId}-c${id.clipId}`;
}

// storage stem — path prefix, no bucket, no extension; Postgres stores it and
// every leaf derives from it. Interim callers pass client ids as PK stand-ins;
// phase 3 (create inversion) passes server-assigned PKs.
export function masterStem(projectId: number, sessionId: number, pk: number): string {
  return `p${projectId}/s${sessionId}/master_${pk}`;
}

// clip nests under its master and its inspection type
export function clipStem(
  projectId: number,
  sessionId: number,
  masterVideoId: number,
  typeCode: InspectionTypeCode,
  clipId: number,
): string {
  return `p${projectId}/s${sessionId}/master_${masterVideoId}/${typeCode}/clip_${clipId}`;
}

// MPU target: raw is one flat object per recording (rebuildable? no)
export function rawLeaf(stem: string): Leaf {
  return { bucket: env.BUCKET_RAW, key: `${stem}.ts` };
}

// derived leaves shared by master and clip recordings (media + thumbs rebuild from raw)
function recordingLeaves(stem: string) {
  return {
    raw: rawLeaf(stem),
    mkv: { bucket: env.BUCKET_MEDIA, key: `${stem}/video.mkv` },
    hlsManifest: { bucket: env.BUCKET_MEDIA, key: `${stem}/hls/index.m3u8` },
    hlsMedia: { bucket: env.BUCKET_MEDIA, key: `${stem}/hls/media.ts` },
    poster: { bucket: env.BUCKET_THUMBNAILS, key: `${stem}/poster.jpg` },
  };
}

export const masterLeaves = recordingLeaves;
export const clipLeaves = recordingLeaves;

// filmstrip still — 9-digit ms padding keeps lexicographic order = time order
export function timelineStill(stem: string, timestampMs: number): Leaf {
  return {
    bucket: env.BUCKET_THUMBNAILS,
    key: `${stem}/timeline/${String(timestampMs).padStart(9, "0")}.jpg`,
  };
}

// upload formats the app sends; the extension is never guessed from the bytes
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function imageExtension(contentType: string): string | null {
  return IMAGE_EXTENSIONS[contentType] ?? null;
}

// snip originals and their annotated twins share one imageId: annotation edits
// the image, never clones it. Superseded by the dated results directory below.

// stem tail {kind}_{pk} maps a stored stem back to its domain row; failure
// paths use this until the tracker carries the link natively (phase 5)
export function stemPk(stem: string): { kind: "master" | "clip"; pk: number } | null {
  const m = /\/(master|clip)_(\d+)$/.exec(stem);
  return m ? { kind: m[1] as "master" | "clip", pk: Number(m[2]) } : null;
}

/* =========================================================
   V2 RECORDING (protocol 2) — uuid-addressed objects
========================================================= */

// zero-padded ten-digit segment index — lexicographic order = numeric order
export function v2SegmentIndexName(index: number): string {
  return `${String(index).padStart(10, "0")}.ts`;
}

// immutable per-recording object prefix (raw bucket)
export function v2RecordingPrefix(recordingId: string): string {
  return `recordings/${recordingId}`;
}

// one sealed segment object — the v2 raw leaf
export function v2SegmentLeaf(recordingId: string, index: number): Leaf {
  return {
    bucket: env.BUCKET_RAW,
    key: `${v2RecordingPrefix(recordingId)}/segments/${v2SegmentIndexName(index)}`,
  };
}

// derived playback artifacts for one published revision (media bucket)
export function v2PlaybackPrefix(recordingId: string, revision: number): Leaf {
  return {
    bucket: env.BUCKET_MEDIA,
    key: `${v2RecordingPrefix(recordingId)}/playback/${revision}`,
  };
}

/* =========================================================
   DIRECT MEDIA KEYS (protocol 3)
   One bucket, one hierarchy:
   <org>/<project>/<session>/<YYYY>/<MM>/<DD>/<kind>/<targetId>/<leaf>
   The date comes from the recording start UTC, so a capture that
   crosses midnight keeps one directory.
========================================================= */

// directory segments of the new hierarchy; "clips" is plural by design
export type MediaKind = "master" | "clips" | "results";

export interface MediaScope {
  organizationId: number;
  projectId: number;
  sessionId: number;
  // recording start, UTC — the key date
  startedAt: Date;
}

// UTC date parts of the recording start: the key date never moves at midnight
export function mediaDatePath(startedAt: Date): string {
  const year = String(startedAt.getUTCFullYear()).padStart(4, "0");
  const month = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(startedAt.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

// shared prefix for every leaf of one recording; a clip passes its master's scope
export function mediaPrefix(scope: MediaScope, kind: MediaKind, targetId: number): string {
  const { organizationId, projectId, sessionId } = scope;
  return `${organizationId}/${projectId}/${sessionId}/${mediaDatePath(scope.startedAt)}/${kind}/${targetId}`;
}

// one leaf under the prefix; every direct-media object lives in the media bucket
export function mediaLeaf(
  scope: MediaScope,
  kind: MediaKind,
  targetId: number,
  leaf: string,
): Leaf {
  return { bucket: env.BUCKET_MEDIA, key: `${mediaPrefix(scope, kind, targetId)}/${leaf}` };
}

// one sealed TS segment for a master
export function masterSegmentLeaf(
  scope: MediaScope,
  masterVideoId: number,
  sequence: number,
): Leaf {
  return mediaLeaf(scope, "master", masterVideoId, `segments/${v2SegmentIndexName(sequence)}`);
}

// one sealed TS segment for a clip; the scope carries the master's date
export function clipSegmentLeaf(scope: MediaScope, clipId: number, sequence: number): Leaf {
  return mediaLeaf(scope, "clips", clipId, `segments/${v2SegmentIndexName(sequence)}`);
}

// poster frame, written after the master closes
export function posterLeaf(scope: MediaScope, masterVideoId: number): Leaf {
  return mediaLeaf(scope, "master", masterVideoId, "poster.jpg");
}

// filmstrip still; 9-digit ms padding keeps lexicographic order = time order
export function filmstripLeaf(scope: MediaScope, masterVideoId: number, timestampMs: number): Leaf {
  return mediaLeaf(
    scope,
    "master",
    masterVideoId,
    `timeline/${String(timestampMs).padStart(9, "0")}.jpg`,
  );
}

// requested MKV export; master and clip ranges share one shape
export function exportLeaf(
  scope: MediaScope,
  kind: "master" | "clips",
  targetId: number,
  exportId: number,
): Leaf {
  return mediaLeaf(scope, kind, targetId, `exports/export_${exportId}.mkv`);
}

// result images sit under the session date of the recording that produced them.
// The stem is the results directory, so a read rebuilds both leaves from it.
export function resultImageStem(scope: MediaScope, resultId: number): string {
  return mediaPrefix(scope, "results", resultId);
}

// raw and annotated twins of one image, under a results-directory stem
export function imageLeavesUnder(
  stem: string,
  imageId: number,
  contentType: string,
): { raw: Leaf; annotated: Leaf } {
  const ext = imageExtension(contentType) ?? "png";
  return {
    raw: { bucket: env.BUCKET_MEDIA, key: `${stem}/img_${imageId}_raw.${ext}` },
    annotated: { bucket: env.BUCKET_MEDIA, key: `${stem}/img_${imageId}_annotated.${ext}` },
  };
}

export function resultImageLeaves(
  scope: MediaScope,
  resultId: number,
  imageId: number,
  contentType: string,
): { raw: Leaf; annotated: Leaf } {
  return imageLeavesUnder(resultImageStem(scope, resultId), imageId, contentType);
}

// flow: organizationId > null > default org. project.organizationId stays
// nullable until better-auth lands, and no key may open with an empty segment.
export async function resolveOrganizationId(
  organizationId: number | null,
  database?: DbOrTx,
): Promise<number> {
  if (organizationId !== null) return organizationId;
  const org = await ensureDefaultOrganization(database);
  if (!org) {
    throw new AppError(500, "default_org_missing", "default organization is not seeded");
  }
  return org.organizationId;
}
