// The ONE place app identity becomes bucket+key pairs (spec: path module owns
// every leaf). flow: frozen prefix > leaf pairs; no key literal anywhere else.
// One bucket: every direct-media object lives in BUCKET_MEDIA.

import { env } from "../../config/env";

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

// zero-padded ten-digit segment index — lexicographic order = numeric order
export function v2SegmentIndexName(index: number): string {
  return `${String(index).padStart(10, "0")}.ts`;
}

// UTC date parts of the recording start, YYYY/MM/DD: the value the ingest row
// stores in key_date. A midnight rollover never moves it.
export function mediaDatePath(startedAt: Date): string {
  const year = String(startedAt.getUTCFullYear()).padStart(4, "0");
  const month = String(startedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(startedAt.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
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

export interface ClipFolderInput {
  clipId: number;
  itemLabel: string;
  inspectionType: string;
}

// <clipId>-<itemSlug>-<inspection>: the folder names its own inspection
const clipFolder = (clip: ClipFolderInput): string =>
  joinParts([String(clip.clipId), slugify(clip.itemLabel), clip.inspectionType.toLowerCase()]);

export interface ClipKeyPrefixInput extends KeyPrefixInput, ClipFolderInput {}

// same session root as the master, then the clip's own folder
export function buildClipKeyPrefix(input: ClipKeyPrefixInput): string {
  return `${projectFolder(input)}/${sessionFolder(input)}/clips/${clipFolder(input)}`;
}

// where an evidence image lives, frozen on its own row at ticket time
export const EVIDENCE_FOLDER = "evidence-img";

export interface ResultEvidenceStemInput extends KeyPrefixInput {
  resultId: number;
  itemLabel: string;
  // present when the result has a clip: the image then sits beside it
  clip?: ClipFolderInput;
}

// flow: project + session root > clip folder when a clip exists, else a results
// folder. The two homes are both valid and both frozen, so a read never breaks.
export function resultEvidenceStem(input: ResultEvidenceStemInput): string {
  const root = `${projectFolder(input)}/${sessionFolder(input)}`;
  if (input.clip) {
    return `${root}/clips/${clipFolder(input.clip)}/${EVIDENCE_FOLDER}`;
  }
  const results = joinParts([String(input.resultId), slugify(input.itemLabel)]);
  return `${root}/results/${results}/${EVIDENCE_FOLDER}`;
}

// raw and annotated twins of one image, minted from a stored stem.
// A readable stem names the file by its id. A legacy numeric stem keeps the
// names already on disk, so every image uploaded before this change resolves.
export function imageEvidenceLeaves(
  stem: string,
  imageId: number,
  contentType: string,
): { raw: Leaf; annotated: Leaf } {
  const ext = imageExtension(contentType) ?? "png";
  const readable = stem.endsWith(`/${EVIDENCE_FOLDER}`);
  return {
    raw: {
      bucket: env.BUCKET_MEDIA,
      key: readable ? `${stem}/${imageId}.${ext}` : `${stem}/img_${imageId}_raw.${ext}`,
    },
    annotated: {
      bucket: env.BUCKET_MEDIA,
      key: readable
        ? `${stem}/${imageId}-annotated.${ext}`
        : `${stem}/img_${imageId}_annotated.${ext}`,
    },
  };
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
