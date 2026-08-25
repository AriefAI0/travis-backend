// The ONE place app identity becomes bucket+key pairs (spec: path module owns
// every leaf). flow: identity > stem > leaf pairs; no key literal anywhere else.

import { env } from "../../config/env";
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

// snip set stem — carries the type, never nested under a clip
export function snipStem(
  projectId: number,
  sessionId: number,
  typeCode: InspectionTypeCode,
  resultId: number,
): string {
  return `p${projectId}/s${sessionId}/${typeCode}/result_${resultId}`;
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

// snip originals live beside their annotated twins in the images bucket
export function snipImages(stem: string, imageId: number) {
  return {
    raw: { bucket: env.BUCKET_IMAGES, key: `${stem}/img_${imageId}_raw.jpg` },
    annotated: { bucket: env.BUCKET_IMAGES, key: `${stem}/img_${imageId}_annotated.jpg` },
  };
}

// stem tail {kind}_{pk} maps a stored stem back to its domain row; failure
// paths use this until the tracker carries the link natively (phase 5)
export function stemPk(stem: string): { kind: "master" | "clip"; pk: number } | null {
  const m = /\/(master|clip)_(\d+)$/.exec(stem);
  return m ? { kind: m[1] as "master" | "clip", pk: Number(m[2]) } : null;
}
