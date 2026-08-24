import { describe, expect, test } from "bun:test";
import {
  clipLeaves,
  clipStem,
  identityString,
  masterLeaves,
  masterStem,
  rawLeaf,
  snipImages,
  snipStem,
  stemPk,
  timelineStill,
} from "../../../src/features/minio_handler/paths";

const MASTER = { kind: "master", projectId: 3, sessionId: 12, recordingId: 45 } as const;
const CLIP = { kind: "clip", projectId: 3, sessionId: 12, itemId: 7, clipId: 45 } as const;

const MASTER_STEM = "p3/s12/master_45";
const CLIP_STEM = "p3/s12/clip_45";
const SNIP_STEM = "p3/s12/result_88";

describe("identityString", () => {
  test("encodes each kind canonically", () => {
    expect(identityString(MASTER)).toBe("p3-s12-r45");
    expect(identityString(CLIP)).toBe("p3-s12-i7-c45");
  });

  test("master and clip identities never collide", () => {
    const strings = new Set<string>();
    for (let n = 1; n <= 50; n++) {
      strings.add(identityString({ kind: "master", projectId: n, sessionId: n, recordingId: n }));
      strings.add(identityString({ kind: "clip", projectId: n, sessionId: n, itemId: n, clipId: n }));
    }
    expect(strings.size).toBe(100);
  });
});

describe("stems", () => {
  test("two hierarchy levels only, kind-prefixed PK last", () => {
    expect(masterStem(3, 12, 45)).toBe(MASTER_STEM);
    expect(clipStem(3, 12, 45)).toBe(CLIP_STEM);
    expect(snipStem(3, 12, 88)).toBe(SNIP_STEM);
  });
});

describe("rawLeaf", () => {
  test("one flat object per recording in the raw bucket", () => {
    expect(rawLeaf(MASTER_STEM)).toEqual({ bucket: "travis-raw", key: `${MASTER_STEM}.ts` });
  });
});

describe("masterLeaves / clipLeaves", () => {
  test("derived buckets hold one directory per recording", () => {
    const expected = (stem: string) => ({
      raw: { bucket: "travis-raw", key: `${stem}.ts` },
      mkv: { bucket: "travis-media", key: `${stem}/video.mkv` },
      hlsManifest: { bucket: "travis-media", key: `${stem}/hls/index.m3u8` },
      hlsMedia: { bucket: "travis-media", key: `${stem}/hls/media.ts` },
      poster: { bucket: "travis-thumbs", key: `${stem}/poster.jpg` },
    });
    expect(masterLeaves(MASTER_STEM)).toEqual(expected(MASTER_STEM));
    expect(clipLeaves(CLIP_STEM)).toEqual(expected(CLIP_STEM));
  });

  test("every leaf carries its bucket — no bare strings", () => {
    for (const leaf of Object.values(masterLeaves(MASTER_STEM))) {
      expect(leaf.bucket).toBeTruthy();
      expect(leaf.key.startsWith(MASTER_STEM)).toBe(true);
    }
  });
});

describe("timelineStill", () => {
  test("zero-pads ms to 9 digits so lexicographic order = time order", () => {
    expect(timelineStill(MASTER_STEM, 0).key).toBe(`${MASTER_STEM}/timeline/000000000.jpg`);
    expect(timelineStill(MASTER_STEM, 1500).key).toBe(`${MASTER_STEM}/timeline/000001500.jpg`);
    expect(timelineStill(MASTER_STEM, 120_000).key).toBe(`${MASTER_STEM}/timeline/000120000.jpg`);
    expect(timelineStill(MASTER_STEM, 1500).key < timelineStill(MASTER_STEM, 120_000).key).toBe(true);
  });

  test("stills live in the thumbs bucket", () => {
    expect(timelineStill(MASTER_STEM, 1).bucket).toBe("travis-thumbs");
  });
});

describe("snipImages", () => {
  test("annotated lives beside raw in the images bucket", () => {
    expect(snipImages(SNIP_STEM, 12)).toEqual({
      raw: { bucket: "travis-images", key: `${SNIP_STEM}/img_12_raw.jpg` },
      annotated: { bucket: "travis-images", key: `${SNIP_STEM}/img_12_annotated.jpg` },
    });
  });
});

describe("stemPk", () => {
  test("maps a master or clip stem back to its domain row", () => {
    expect(stemPk(MASTER_STEM)).toEqual({ kind: "master", pk: 45 });
    expect(stemPk(CLIP_STEM)).toEqual({ kind: "clip", pk: 45 });
  });

  test("rejects snip stems and malformed strings", () => {
    expect(stemPk(SNIP_STEM)).toBeNull();
    expect(stemPk("")).toBeNull();
    expect(stemPk("master_45")).toBeNull(); // bare leaf, no parent path
    expect(stemPk("p3/s12/master_abc")).toBeNull();
  });
});
