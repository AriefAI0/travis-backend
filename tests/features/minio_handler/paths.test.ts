import { describe, expect, test } from "bun:test";
import { baseKey, identityString, leafKeys, rawKey, timelineKey } from "../../../src/features/minio_handler/paths";

const MASTER = { kind: "master", projectId: 3, sessionId: 12, recordingId: 45 } as const;
const CLIP = { kind: "clip", projectId: 3, sessionId: 12, itemId: 7, clipId: 45 } as const;

const MASTER_BASE = "projects/3/sessions/12/recordings/45";
const CLIP_BASE = "projects/3/sessions/12/items/7/clips/45";

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

describe("baseKey", () => {
  test("master nests under recordings, clip under items/clips", () => {
    expect(baseKey(MASTER)).toBe(MASTER_BASE);
    expect(baseKey(CLIP)).toBe(CLIP_BASE);
  });
});

describe("rawKey / leafKeys", () => {
  test("master leaves", () => {
    expect(rawKey("master", MASTER_BASE)).toBe(`${MASTER_BASE}/master.ts`);
    expect(leafKeys("master", MASTER_BASE)).toEqual({
      raw: `${MASTER_BASE}/master.ts`,
      mkv: `${MASTER_BASE}/master.mkv`,
      hlsManifest: `${MASTER_BASE}/hls/index.m3u8`,
      hlsMedia: `${MASTER_BASE}/hls/media.ts`,
      thumb: `${MASTER_BASE}/thumb.jpg`,
    });
  });

  test("clip leaves", () => {
    expect(leafKeys("clip", CLIP_BASE)).toEqual({
      raw: `${CLIP_BASE}/clip.ts`,
      mkv: `${CLIP_BASE}/clip.mkv`,
      hlsManifest: `${CLIP_BASE}/hls/index.m3u8`,
      hlsMedia: `${CLIP_BASE}/hls/media.ts`,
      thumb: `${CLIP_BASE}/thumb.jpg`,
    });
  });
});

describe("timelineKey", () => {
  test("zero-pads seconds to 6 digits", () => {
    expect(timelineKey(MASTER_BASE, 0)).toBe(`${MASTER_BASE}/timeline/000000.jpg`);
    expect(timelineKey(MASTER_BASE, 123)).toBe(`${MASTER_BASE}/timeline/000123.jpg`);
  });
});
