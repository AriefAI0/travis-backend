// The ONE place app identity becomes bucket+key pairs (spec: path module owns
// every leaf). flow: scope > prefix > leaf pairs; no key literal anywhere else.
// One bucket: every direct-media object lives in BUCKET_MEDIA.

import { env } from "../../config/env";
import type { DbOrTx } from "../../db/client";
import { ensureDefaultOrganization } from "../../db/ensure-org";
import { AppError } from "../error";

export interface Leaf {
  bucket: string;
  key: string;
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

/* =========================================================
   DIRECT MEDIA KEYS
   One bucket, one hierarchy:
   <org>/<project>/<session>/<YYYY>/<MM>/<DD>/<kind>/<targetId>/<leaf>
   The date comes from the recording start UTC, so a capture that
   crosses midnight keeps one directory.
========================================================= */

// directory segments of the new hierarchy; "clips" is plural by design
export type MediaKind = "master" | "clips" | "results";

// zero-padded ten-digit segment index — lexicographic order = numeric order
export function v2SegmentIndexName(index: number): string {
  return `${String(index).padStart(10, "0")}.ts`;
}

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

/* =========================================================
   READABLE MEDIA KEYS (v3)
   The ingest row freezes one directory at admission, so a
   later rename never scatters one recording across two trees.
   <projectId>-<titleSlug>-<YYYY-MM-DD>/session-<n>-<YYYY-MM-DD>-<HHMM>/<kind>
   Leaves are a fixed tail under that frozen prefix.
========================================================= */

const pad = (value: number, width: number) => String(value).padStart(width, "0");

// non-empty parts joined with a dash: a missing slug leaves no double dash
const joinParts = (parts: string[]): string =>
  parts.filter((part) => part.length > 0).join("-");

// lowercase, non-alphanumerics to dashes, first 3 words, hard cut at 24
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-")
    .slice(0, 24)
    // a hard cut can land on a dash
    .replace(/-+$/, "");
}

// UTC day of the recording start: YYYY-MM-DD
const utcDay = (startEpoch: number): string => {
  const at = new Date(startEpoch * 1000);
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1, 2)}-${pad(at.getUTCDate(), 2)}`;
};

// UTC clock of the recording start: HHMM
const utcClock = (startEpoch: number): string => {
  const at = new Date(startEpoch * 1000);
  return `${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}`;
};

export interface KeyPrefixInput {
  projectId: number;
  projectTitle: string;
  displayNumber: number;
  // recording start, epoch SECONDS, frozen at admission
  startEpoch: number;
}

// <projectId>-<titleSlug>-<YYYY-MM-DD>: the project folder carries the date
const projectFolder = (input: KeyPrefixInput): string =>
  joinParts([String(input.projectId), slugify(input.projectTitle), utcDay(input.startEpoch)]);

// session-<displayNumber>-<YYYY-MM-DD>-<HHMM>
const sessionFolder = (input: KeyPrefixInput): string =>
  joinParts([
    "session",
    String(input.displayNumber),
    utcDay(input.startEpoch),
    utcClock(input.startEpoch),
  ]);

// admission is 1:1, so a session holds exactly one master
export function buildMasterKeyPrefix(input: KeyPrefixInput): string {
  return `${projectFolder(input)}/${sessionFolder(input)}/master-video`;
}

export interface ClipKeyPrefixInput extends KeyPrefixInput {
  clipId: number;
  itemLabel: string;
  inspectionType: string;
}

// <clipId>-<itemSlug>-<inspection>: the folder names its own inspection
const clipFolder = (input: ClipKeyPrefixInput): string =>
  joinParts([String(input.clipId), slugify(input.itemLabel), input.inspectionType.toLowerCase()]);

// same session root as the master, then the clip's own folder
export function buildClipKeyPrefix(input: ClipKeyPrefixInput): string {
  return `${projectFolder(input)}/${sessionFolder(input)}/clips/${clipFolder(input)}`;
}

// one leaf under a frozen prefix; every direct-media object lives in the media bucket
const mediaLeafV2 = (keyPrefix: string, leaf: string): Leaf => ({
  bucket: env.BUCKET_MEDIA,
  key: `${keyPrefix}/${leaf}`,
});

// one sealed TS segment; master and clip share this tail
export function segmentLeafV2(keyPrefix: string, sequence: number): Leaf {
  return mediaLeafV2(keyPrefix, `segments/${v2SegmentIndexName(sequence)}`);
}

// poster frame, written after the master closes
export function posterLeafV2(keyPrefix: string): Leaf {
  return mediaLeafV2(keyPrefix, "thumbnail.jpg");
}

// filmstrip still; 9-digit ms padding keeps lexicographic order = time order
export function filmstripLeafV2(keyPrefix: string, timestampMs: number): Leaf {
  return mediaLeafV2(keyPrefix, `timeline/${pad(timestampMs, 9)}.jpg`);
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
