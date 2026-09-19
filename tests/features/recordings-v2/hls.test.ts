import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import {
  buildPlaylist,
  contiguousPrefix,
  HLS_OPEN_WINDOW_ENTRIES,
  openWindow,
  readPlaylistSource,
  targetDurationSeconds,
  type PlaylistSegment,
} from "../../../src/features/recordings-v2/hls";

const segment = (sequence: number, durationMs = 2000, discontinuity = false): PlaylistSegment => ({
  sequence,
  durationMs,
  discontinuity,
});

const rows = (count: number) => Array.from({ length: count }, (_, i) => segment(i));

const uri = (sequence: number) => `seg/${String(sequence).padStart(10, "0")}.ts?t=TOKEN`;

describe("playlist rendering", () => {
  test("a closed playlist is a complete VOD range", () => {
    const playlist = buildPlaylist(
      {
        segments: rows(3),
        closed: true,
        mediaSequence: 0,
        targetDurationSeconds: targetDurationSeconds(rows(3)),
      },
      uri,
    );

    expect(playlist).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:2.000,",
        "seg/0000000000.ts?t=TOKEN",
        "#EXTINF:2.000,",
        "seg/0000000001.ts?t=TOKEN",
        "#EXTINF:2.000,",
        "seg/0000000002.ts?t=TOKEN",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
  });

  test("an open playlist carries no ENDLIST and keeps the media sequence", () => {
    const playlist = buildPlaylist(
      { segments: rows(2), closed: false, mediaSequence: 40, targetDurationSeconds: 2 },
      uri,
    );

    expect(playlist).toContain("#EXT-X-MEDIA-SEQUENCE:40");
    expect(playlist).not.toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlist).not.toContain("#EXT-X-ENDLIST");
  });

  test("measured durations reach EXTINF and the target duration", () => {
    const mixed = [segment(0, 1999), segment(1, 10_000), segment(2, 1500)];
    expect(targetDurationSeconds(mixed)).toBe(10);

    const playlist = buildPlaylist(
      { segments: mixed, closed: true, mediaSequence: 0, targetDurationSeconds: 10 },
      uri,
    );
    expect(playlist).toContain("#EXTINF:1.999,");
    expect(playlist).toContain("#EXTINF:10.000,");
    expect(playlist).toContain("#EXTINF:1.500,");
  });

  test("stored discontinuities render before their segment", () => {
    const playlist = buildPlaylist(
      {
        segments: [segment(0), segment(1, 2000, true)],
        closed: true,
        mediaSequence: 0,
        targetDurationSeconds: 2,
      },
      uri,
    );

    expect(playlist.split("\n").filter((line) => line === "#EXT-X-DISCONTINUITY")).toHaveLength(1);
    expect(playlist).toContain("#EXT-X-DISCONTINUITY\n#EXTINF:2.000,\nseg/0000000001.ts?t=TOKEN");
  });

  test("every child URI repeats the token and the sequence", () => {
    const playlist = buildPlaylist(
      { segments: rows(4), closed: true, mediaSequence: 0, targetDurationSeconds: 2 },
      uri,
    );

    const uris = playlist.split("\n").filter((line) => line.endsWith(".ts?t=TOKEN"));
    expect(uris).toHaveLength(4);
    for (const line of uris) expect(line).toContain("?t=TOKEN");
  });
});

describe("prefix and window", () => {
  test("a hole ends the prefix and hides every straggler", () => {
    const prefix = contiguousPrefix([segment(0), segment(1), segment(3), segment(4)]);
    expect(prefix.map((row) => row.sequence)).toEqual([0, 1]);
  });

  test("unordered rows still walk in sequence order", () => {
    const prefix = contiguousPrefix([segment(2), segment(0), segment(1)]);
    expect(prefix.map((row) => row.sequence)).toEqual([0, 1, 2]);
  });

  test("an empty ingest yields an empty prefix", () => {
    expect(contiguousPrefix([])).toEqual([]);
  });

  // the locked window: at most 540 newest entries, whatever the recording length
  test("539 rows stay whole", () => {
    const window = openWindow(rows(539));
    expect(window.segments).toHaveLength(539);
    expect(window.mediaSequence).toBe(0);
  });

  test("540 rows stay whole", () => {
    const window = openWindow(rows(540));
    expect(window.segments).toHaveLength(540);
    expect(window.mediaSequence).toBe(0);
  });

  test("541 rows drop the oldest and move the media sequence", () => {
    const window = openWindow(rows(541));
    expect(window.segments).toHaveLength(HLS_OPEN_WINDOW_ENTRIES);
    expect(window.mediaSequence).toBe(1);
    expect(window.segments[0]!.sequence).toBe(1);
    expect(window.segments.at(-1)!.sequence).toBe(540);
  });

  test("a window that starts mid-recording never renumbers the children", () => {
    const window = openWindow(rows(900));
    const playlist = buildPlaylist(
      { ...window, closed: false, targetDurationSeconds: 2 },
      uri,
    );
    const firstUri = playlist.split("\n").find((line) => line.startsWith("seg/"));
    expect(firstUri).toBe(`seg/${String(360).padStart(10, "0")}.ts?t=TOKEN`);
    expect(playlist).toContain("#EXT-X-MEDIA-SEQUENCE:360");
  });
});

describe("playlist snapshot", () => {
  const PROJECT_ID = 9500;

  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await testDb.insert(schema.project).values({ projectId: PROJECT_ID, title: "P" });
    await testDb
      .insert(schema.session)
      .values({ sessionId: PROJECT_ID, projectId: PROJECT_ID, name: "S" });
  });

  // one master with an ingest row, and segments written straight to the ledger
  const seedIngest = async (options: {
    closed: boolean;
    finalSequence?: number;
    sequences: { sequence: number; durationMs?: number }[];
  }) => {
    const [master] = await testDb
      .insert(schema.masterVideo)
      .values({ sessionId: PROJECT_ID, startEpoch: 1_760_000_000 })
      .returning({ masterVideoId: schema.masterVideo.masterVideoId });

    const [ingest] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        masterVideoId: master!.masterVideoId,
        ticketHash: "a".repeat(64),
        keyDate: "2026-09-20",
        closedAt: options.closed ? new Date() : null,
        finalSequence: options.finalSequence ?? null,
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });

    for (const row of options.sequences) {
      await testDb.insert(schema.recordingIngestSegment).values({
        ingestId: ingest!.ingestId,
        sequence: row.sequence,
        checksumSha256: "b".repeat(64),
        sizeBytes: 1024,
        durationMs: row.durationMs ?? 2000,
        objectKey: `key/${row.sequence}.ts`,
      });
    }

    return { masterVideoId: master!.masterVideoId, ingestId: ingest!.ingestId };
  };

  test("an open ingest serves its contiguous prefix as a live playlist", async () => {
    const { masterVideoId } = await seedIngest({
      closed: false,
      sequences: [{ sequence: 0 }, { sequence: 1 }, { sequence: 3 }],
    });

    const source = await readPlaylistSource({ kind: "master", id: masterVideoId }, testDb);

    expect(source.closed).toBe(false);
    expect(source.segments.map((row) => row.sequence)).toEqual([0, 1]);
    expect(source.mediaSequence).toBe(0);
  });

  test("a closed ingest stops at its frozen range", async () => {
    const { masterVideoId } = await seedIngest({
      closed: false,
      sequences: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }],
    });
    const source = await readPlaylistSource({ kind: "master", id: masterVideoId }, testDb);
    expect(source.closed).toBe(false);

    // close it at sequence 1; the stored sequence 2 is now a straggler
    await testDb
      .update(schema.recordingIngest)
      .set({ closedAt: new Date(), finalSequence: 1 })
      .where(eq(schema.recordingIngest.masterVideoId, masterVideoId));

    const closed = await readPlaylistSource({ kind: "master", id: masterVideoId }, testDb);
    expect(closed.closed).toBe(true);
    expect(closed.segments.map((row) => row.sequence)).toEqual([0, 1]);
    expect(closed.mediaSequence).toBe(0);
    expect(buildPlaylist(closed, uri)).toContain("#EXT-X-ENDLIST");
  });

  test("an empty ingest renders an empty playlist, not an error", async () => {
    const { masterVideoId } = await seedIngest({ closed: false, sequences: [] });
    const source = await readPlaylistSource({ kind: "master", id: masterVideoId }, testDb);
    expect(source.segments).toEqual([]);
    expect(buildPlaylist(source, uri).split("\n").filter((line) => line.startsWith("seg/"))).toEqual([]);
  });

  test("a recording with no ingest at all is 404", async () => {
    await testDb.insert(schema.masterVideo).values({ sessionId: PROJECT_ID, startEpoch: 1 });
    const [master] = await testDb.select().from(schema.masterVideo);

    await expect(
      readPlaylistSource({ kind: "master", id: master!.masterVideoId }, testDb),
    ).rejects.toThrow(/Ingest not found/i);
  });

  test("a live ingest wins over an older closed one", async () => {
    const { masterVideoId } = await seedIngest({
      closed: true,
      finalSequence: 0,
      sequences: [{ sequence: 0 }],
    });
    const [live] = await testDb
      .insert(schema.recordingIngest)
      .values({
        kind: "master",
        masterVideoId,
        ticketHash: "d".repeat(64),
        keyDate: "2026-09-20",
      })
      .returning({ ingestId: schema.recordingIngest.ingestId });
    await testDb.insert(schema.recordingIngestSegment).values({
      ingestId: live!.ingestId,
      sequence: 0,
      checksumSha256: "e".repeat(64),
      sizeBytes: 1024,
      durationMs: 2500,
      objectKey: "live/0.ts",
    });

    const source = await readPlaylistSource({ kind: "master", id: masterVideoId }, testDb);
    expect(source.closed).toBe(false);
    expect(source.targetDurationSeconds).toBe(3);
  });
});
