import { describe, expect, test } from "bun:test";

import {
  buildClipKeyPrefix,
  buildMasterKeyPrefix,
  EVIDENCE_FOLDER,
  filmstripLeafV2,
  imageEvidenceLeaves,
  mediaDatePath,
  posterLeafV2,
  resultEvidenceStem,
  segmentLeafV2,
  slugify,
  v2SegmentIndexName,
} from "../../../src/lib/minio_storage/paths";

describe("the ingest key date", () => {
  test("mediaDatePath zero-pads the UTC date of the recording start", () => {
    expect(mediaDatePath(new Date("2026-09-20T23:59:59.000Z"))).toBe("2026/09/20");
    expect(mediaDatePath(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026/01/05");
    expect(mediaDatePath(new Date("2026-10-01T12:00:00.000Z"))).toBe("2026/10/01");
  });

  // a local-time reading would answer 09/21 whenever the host sits east of UTC
  test("the key date is UTC and never rolls at midnight", () => {
    expect(mediaDatePath(new Date("2026-09-20T23:59:59.000Z"))).toBe("2026/09/20");
    expect(mediaDatePath(new Date("2026-09-21T00:00:01.000Z"))).toBe("2026/09/21");
    expect(mediaDatePath(new Date("2025-12-31T23:59:59.000Z"))).toBe("2025/12/31");
  });

  test("the segment index is ten digits, so string order is time order", () => {
    expect(v2SegmentIndexName(0)).toBe("0000000000.ts");
    expect(v2SegmentIndexName(3)).toBe("0000000003.ts");
    expect(v2SegmentIndexName(12) < v2SegmentIndexName(120)).toBe(true);
  });
});

describe("readable key prefixes", () => {
  // 2026-02-19T13:07:42Z
  const START_EPOCH = Math.floor(Date.parse("2026-02-19T13:07:42.000Z") / 1000);
  const PROJECT = {
    projectNumber: 1,
    projectTitle: "Platform North",
    displayNumber: 1,
    startEpoch: START_EPOCH,
  };
  const SESSION_ROOT = "1-platform-north-2026-02-19/session-1-2026-02-19-1307";

  test("slugify lowercases, dashes, caps at 3 words and 24 chars", () => {
    expect(slugify("Platform North")).toBe("platform-north");
    expect(slugify("Anode 14 GVI inspection")).toBe("anode-14-gvi");
    expect(slugify("  Anode -- 14  ")).toBe("anode-14");
    expect(slugify("A B C D")).toBe("a-b-c");
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
    expect(slugify("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwx");
  });

  // a cut through the 24th char can land on a dash
  test("a hard cut never leaves a trailing dash", () => {
    expect(slugify(`${"a".repeat(23)}-b`)).toBe("a".repeat(23));
  });

  test("the master prefix carries the project, the session, and the UTC start", () => {
    expect(buildMasterKeyPrefix(PROJECT)).toBe(`${SESSION_ROOT}/master-video`);
  });

  test("the clip prefix nests under the same session root", () => {
    expect(
      buildClipKeyPrefix({
        ...PROJECT,
        resultNumber: 455,
        itemLabel: "Anode 14",
        inspectionType: "GVI",
      }),
    ).toBe(`${SESSION_ROOT}/clips/455-anode-14-gvi`);
  });

  test("an empty part drops out instead of leaving a double dash", () => {
    expect(buildMasterKeyPrefix({ ...PROJECT, projectTitle: "!!!" })).toBe(
      "1-2026-02-19/session-1-2026-02-19-1307/master-video",
    );
    expect(
      buildClipKeyPrefix({
        ...PROJECT,
        resultNumber: 455,
        itemLabel: "",
        inspectionType: "GVI",
      }),
    ).toBe(`${SESSION_ROOT}/clips/455-gvi`);
  });

  test("dates and times are UTC, so a local reading never leaks in", () => {
    const lateNight = Math.floor(Date.parse("2026-02-19T23:59:59.000Z") / 1000);
    expect(buildMasterKeyPrefix({ ...PROJECT, startEpoch: lateNight })).toBe(
      "1-platform-north-2026-02-19/session-1-2026-02-19-2359/master-video",
    );

    const justAfter = Math.floor(Date.parse("2026-02-20T00:00:01.000Z") / 1000);
    expect(buildMasterKeyPrefix({ ...PROJECT, startEpoch: justAfter })).toBe(
      "1-platform-north-2026-02-20/session-1-2026-02-20-0000/master-video",
    );
  });
});

describe("frozen-prefix leaves", () => {
  const READABLE = "1-platform-north-2026-02-19/session-1-2026-02-19-1307/master-video";
  // the numeric directory phase 1's backfill wrote onto pre-existing rows
  const BACKFILLED = "1/3/12/2026/09/20/master/45";

  // one tail for both shapes is what lets old rows share the new minters
  test("the segment tail is identical under a readable and a backfilled prefix", () => {
    expect(segmentLeafV2(READABLE, 3).key).toBe(`${READABLE}/segments/0000000003.ts`);
    expect(segmentLeafV2(BACKFILLED, 3).key).toBe(
      `${BACKFILLED}/segments/0000000003.ts`,
    );
  });

  test("the poster is named thumbnail.jpg under the frozen prefix", () => {
    expect(posterLeafV2(READABLE).key).toBe(`${READABLE}/thumbnail.jpg`);
    expect(posterLeafV2(BACKFILLED).key).toBe(`${BACKFILLED}/thumbnail.jpg`);
  });

  test("filmstrip stills sort by time as strings under the frozen prefix", () => {
    expect(filmstripLeafV2(READABLE, 1500).key).toBe(`${READABLE}/timeline/000001500.jpg`);
    expect(filmstripLeafV2(READABLE, 1500).key < filmstripLeafV2(READABLE, 120_000).key).toBe(true);
  });

  test("every frozen-prefix leaf lands in the media bucket", () => {
    const leaves = [
      segmentLeafV2(READABLE, 0),
      segmentLeafV2(BACKFILLED, 0),
      posterLeafV2(READABLE),
      filmstripLeafV2(READABLE, 0),
    ];
    for (const leaf of leaves) expect(leaf.bucket).toBe("travis-media");
  });
});

describe("evidence image homes", () => {
  const START_EPOCH = Math.floor(Date.parse("2026-02-19T13:07:42.000Z") / 1000);
  const ROOT = "1-platform-north-2026-02-19/session-1-2026-02-19-1307";
  const PROJECT = {
    projectNumber: 1,
    projectTitle: "Platform North",
    displayNumber: 1,
    startEpoch: START_EPOCH,
  };
  // one ordinal names both homes: a clip is 1:1 with its result
  const RESULT_NUMBER = 231;

  test("a result with no clip lands under results/<id>-<itemSlug>", () => {
    expect(
      resultEvidenceStem({ ...PROJECT, resultNumber: RESULT_NUMBER, itemLabel: "Anode 14" }),
    ).toBe(`${ROOT}/results/231-anode-14/${EVIDENCE_FOLDER}`);
  });

  test("a result with a clip lands beside that clip, under the same number", () => {
    expect(
      resultEvidenceStem({
        ...PROJECT,
        resultNumber: RESULT_NUMBER,
        itemLabel: "Anode 14",
        clip: { resultNumber: RESULT_NUMBER, itemLabel: "Anode 14", inspectionType: "GVI" },
      }),
    ).toBe(`${ROOT}/clips/231-anode-14-gvi/${EVIDENCE_FOLDER}`);
  });

  // an item label that slugifies empty still leaves a usable folder
  test("an empty item slug drops out of the results folder", () => {
    expect(
      resultEvidenceStem({ ...PROJECT, resultNumber: RESULT_NUMBER, itemLabel: "!!!" }),
    ).toBe(`${ROOT}/results/231/${EVIDENCE_FOLDER}`);
  });

  test("a readable stem names the file by its id", () => {
    const stem = `${ROOT}/clips/231-anode-14-gvi/${EVIDENCE_FOLDER}`;
    expect(imageEvidenceLeaves(stem, 55, "image/png")).toEqual({
      raw: { bucket: "travis-media", key: `${stem}/55.png` },
      annotated: { bucket: "travis-media", key: `${stem}/55-annotated.png` },
    });
  });

  test("the extension follows the upload format, never a guess", () => {
    const stem = `${ROOT}/results/231/${EVIDENCE_FOLDER}`;
    expect(imageEvidenceLeaves(stem, 61, "image/jpeg").raw.key).toBe(`${stem}/61.jpg`);
    expect(imageEvidenceLeaves(stem, 61, "image/webp").annotated.key).toBe(
      `${stem}/61-annotated.webp`,
    );
    expect(imageEvidenceLeaves(stem, 61, "image/gif").raw.key).toBe(`${stem}/61.png`);
  });

  // The compatibility contract: an image stored before the readable layout
  // keeps minting the names already on disk, so it still opens.
  test("a legacy numeric stem keeps its legacy leaf names", () => {
    const legacy = "1/1/214/2026/09/20/results/231";
    expect(imageEvidenceLeaves(legacy, 55, "image/png")).toEqual({
      raw: { bucket: "travis-media", key: `${legacy}/img_55_raw.png` },
      annotated: { bucket: "travis-media", key: `${legacy}/img_55_annotated.png` },
    });
    expect(imageEvidenceLeaves(legacy, 55, "image/jpeg").annotated.key).toBe(
      `${legacy}/img_55_annotated.jpg`,
    );
  });
});

