// The ONE place app identity becomes bucket keys (docs/bucket-layout.md).
// flow: identity > base key > leaf keys; no key literals anywhere else.

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

// canonical uniqueness string — stored in tracker.app_session_id
export function identityString(id: RecordingIdentity): string {
  if (id.kind === "master") return `p${id.projectId}-s${id.sessionId}-r${id.recordingId}`;
  return `p${id.projectId}-s${id.sessionId}-i${id.itemId}-c${id.clipId}`;
}

// shared prefix of every leaf of one recording — stored in tracker.object_key
export function baseKey(id: RecordingIdentity): string {
  if (id.kind === "master") {
    return `projects/${id.projectId}/sessions/${id.sessionId}/recordings/${id.recordingId}`;
  }
  return `projects/${id.projectId}/sessions/${id.sessionId}/items/${id.itemId}/clips/${id.clipId}`;
}

// MPU target key for a stored session (object_key holds the base)
export function rawKey(kind: "master" | "clip", base: string): string {
  return `${base}/${kind === "master" ? "master" : "clip"}.ts`;
}

// every leaf object of one recording, derived from base + kind
export function leafKeys(kind: "master" | "clip", base: string) {
  const stem = kind === "master" ? "master" : "clip";
  return {
    raw: `${base}/${stem}.ts`,
    mkv: `${base}/${stem}.mkv`,
    hlsManifest: `${base}/hls/index.m3u8`,
    hlsMedia: `${base}/hls/media.ts`,
    thumb: `${base}/thumb.jpg`,
  };
}

// filmstrip still — prefix locked, format may evolve (doc §5)
export function timelineKey(base: string, seconds: number): string {
  return `${base}/timeline/${String(seconds).padStart(6, "0")}.jpg`;
}
