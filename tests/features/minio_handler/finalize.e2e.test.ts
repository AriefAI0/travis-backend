import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import pg from "pg";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { finalizeJob } from "../../../src/features/minio_handler/jobs/ffmpeg_finalize";
import { generateSegments } from "../../helpers/fixtures";
import { json } from "../../helpers/json";
import { seedRecordingHierarchy, type SeededHierarchy } from "../../helpers/seed";
import { startServer, type TestServer } from "../../helpers/server";

// Finalize proof (spec Testing #1 tail): stop queues the job, the runner's
// ffmpeg pipeline produces mkv + single-file hls + thumbnail, artifacts route
// hands out presigned URLs that fetch 200.
const SEG_COUNT = 45;
const PART = String(5 * 1024 * 1024);
const DATA_DIR = "./data/test-e2e-finalize";
const SEG_DIR = "/tmp/travis-e2e-segs-finalize";

let segBytes: Uint8Array[];
let server: TestServer;
let seed: SeededHierarchy;
let pool: pg.Pool;

async function pollStatus(id: string, want: (d: any) => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const data = await json(await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`));
    if (want(data.data)) return data.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `status did not reach expected state within ${ms}ms; server logs:\n${server.logs().join("\n")}`,
  );
}

// ffprobe in the test process (fixtures already rely on ffmpeg in PATH)
async function probe(path: string) {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`ffprobe failed: ${out}`);
  return JSON.parse(out);
}

beforeAll(async () => {
  const segPaths = await generateSegments(SEG_DIR, SEG_COUNT);
  segBytes = await Promise.all(segPaths.map(async (p) => new Uint8Array(await Bun.file(p).arrayBuffer())));
  seed = await seedRecordingHierarchy();
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  server = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
}, 120_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  await pool?.end().catch(() => {});
  await seed.cleanup();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

// upload every segment then stop; returns the polled-final status payload
async function recordAndStop(body: Record<string, number | string>) {
  const create = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(create.status).toBe(201);
  const created = (await json(create)).data;

  for (let i = 0; i < SEG_COUNT; i++) {
    const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${created.id}/segments?index=${i}`, {
      method: "POST",
      headers: { "content-type": "video/mp2t" },
      body: segBytes[i],
    });
    expect(res.status).toBe(200);
  }
  const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${created.id}/stop`, { method: "POST" });
  expect(stopRes.status).toBe(202);
  // poll for any terminal state so a failed finalize surfaces fast, with logs
  const final = await pollStatus(
    created.id,
    (d) => d.status === "finalized" || d.status === "finalization_failed",
    90_000,
  );
  if (final.status !== "finalized") {
    throw new Error(`finalize ended as ${final.status}; server logs:\n${server.logs().join("\n")}`);
  }
  return { created, final };
}

async function unfinishedIds(): Promise<number[]> {
  const res = await json(
    await fetch(`${server.baseUrl}/api/v1/recordings/unfinished?projectId=${seed.projectId}`),
  );
  return res.data.map((r: { masterVideoId: number }) => r.masterVideoId);
}

test(
  "stop finalizes into mkv + single-file hls + thumbnail; artifact URLs fetch 200",
  async () => {
    const create = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
    });
    expect(create.status).toBe(201);
    const createdData = (await json(create)).data;
    const id = createdData.id as string;
    const stem = createdData.storageStem as string;
    expect(stem).toBe(`p${seed.projectId}/s${seed.sessionId}/master_${createdData.masterVideoId}`);

    for (let i = 0; i < SEG_COUNT; i++) {
      const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, {
        method: "POST",
        headers: { "content-type": "video/mp2t" },
        body: segBytes[i],
      });
      expect(res.status).toBe(200);
    }

    // artifacts 409 until finalized (spec D2)
    const early = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/artifacts`);
    expect(early.status).toBe(409);

    // create made the recording visible to the app while it records (story 1)
    expect(await unfinishedIds()).toContain(createdData.masterVideoId);

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    const stopBody = await stopRes.text();
    expect(stopRes.status, stopBody).toBe(202);

    const final = await pollStatus(id, (d) => d.status === "finalized", 120_000);
    expect(final.artifactStatus).toBe("ready");

    // presigned URLs from the artifacts route, all fetchable
    const artsRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/artifacts`);
    expect(artsRes.status).toBe(200);
    const arts = (await json(artsRes)).data;
    expect(arts.durationMs).toBeGreaterThan(80_000); // 45 segments x ~2s
    expect(arts.durationMs).toBeLessThan(95_000);

    for (const url of [arts.hls.manifest, arts.hls.media, arts.mkv, arts.thumbnail]) {
      const res = await fetch(url);
      expect(res.status, url).toBe(200);
    }

    // manifest is single-file HLS: byte ranges into one media file
    const manifest = await (await fetch(arts.hls.manifest)).text();
    expect(manifest).toContain("media.ts");
    expect(manifest).toContain("EXT-X-BYTERANGE");

    // mkv probes as h264 with the full duration (stream-copy remux, not 2s of it)
    const mkvPath = `${SEG_DIR}/probe.mkv`;
    await Bun.write(mkvPath, await (await fetch(arts.mkv)).arrayBuffer());
    const info = await probe(mkvPath);
    const video = info.streams.find((s: any) => s.codec_name === "h264");
    expect(video).toBeDefined();
    expect(Number(info.format.duration)).toBeGreaterThan(80);

    // thumbnail is a real JPEG
    const thumb = new Uint8Array(await (await fetch(arts.thumbnail)).arrayBuffer());
    expect(thumb[0]).toBe(0xff);
    expect(thumb[1]).toBe(0xd8);

    // bridge: domain row carries the durable facts, one tx, converged
    const totalBytes = segBytes.reduce((n, b) => n + b.byteLength, 0);
    const mv = (
      await pool.query(
        "select recording_status, duration_ms, file_size, storage_stem, end_epoch - start_epoch as span_s" +
          " from master_video where master_video_id = $1",
        [createdData.masterVideoId],
      )
    ).rows[0];
    expect(mv.recording_status).toBe("finalized");
    expect(mv.storage_stem).toBe(stem);
    expect(mv.duration_ms).toBeGreaterThan(80_000);
    expect(mv.duration_ms).toBeLessThan(95_000);
    expect(Number(mv.file_size)).toBe(totalBytes);
    expect(Number(mv.span_s)).toBeGreaterThanOrEqual(80); // bigint arrives as string

    // finished recording leaves the app's unfinished list (story 1)
    expect(await unfinishedIds()).not.toContain(createdData.masterVideoId);

    // timeline filmstrip: one row per slot, stem-keyed, time order (story 4-5)
    const tt = (
      await pool.query(
        "select timestamp_ms, storage_stem, width, height, size_bytes" +
          " from timeline_thumbnail where master_video_id = $1 order by timestamp_ms",
        [createdData.masterVideoId],
      )
    ).rows;
    expect(tt.length).toBeGreaterThanOrEqual(9); // ~90s take, 10s interval
    expect(tt[0].timestamp_ms).toBe(0);
    for (const r of tt) {
      expect(r.storage_stem).toBe(stem);
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      expect(Number(r.size_bytes)).toBeGreaterThan(0);
    }
    // keys derive from the stem + padded timestamp via the path module
    const firstStillKey = `${stem}/timeline/${String(tt[0].timestamp_ms).padStart(9, "0")}.jpg`;
    const stillStat = await minio.statObject(env.BUCKET_THUMBNAILS, firstStillKey);
    expect(stillStat.size).toBe(Number(tt[0].size_bytes));

    // re-running the job on a finalized session is a no-op — no dup rows
    await finalizeJob({ session_id: id, type: "finalize" } as Parameters<typeof finalizeJob>[0]);
    const ttAfter = (
      await pool.query(
        "select count(*)::int as n from timeline_thumbnail where master_video_id = $1",
        [createdData.masterVideoId],
      )
    ).rows[0].n;
    expect(ttAfter).toBe(tt.length);

    // cleanup: raw master + four artifacts + every timeline still
    await minio.removeObject(env.BUCKET_RAW, `${stem}.ts`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/video.mkv`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/hls/index.m3u8`);
    await minio.removeObject(env.BUCKET_MEDIA, `${stem}/hls/media.ts`);
    await minio.removeObject(env.BUCKET_THUMBNAILS, `${stem}/poster.jpg`);
    for (const r of tt) {
      await minio.removeObject(env.BUCKET_THUMBNAILS, `${stem}/timeline/${String(r.timestamp_ms).padStart(9, "0")}.jpg`);
    }
  },
  180_000,
);

test(
  "clip finalize bridges duration and size onto the video_clip row",
  async () => {
    const { created } = await recordAndStop({
      kind: "clip",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
      itemId: seed.itemId,
      resultId: seed.resultId,
    });
    const totalBytes = segBytes.reduce((n, b) => n + b.byteLength, 0);

    const vc = (
      await pool.query(
        "select recording_status, start_offset_ms, end_offset_ms, file_size, storage_stem" +
          " from video_clip where clip_id = $1",
        [created.clipId],
      )
    ).rows[0];
    expect(vc.recording_status).toBe("finalized");
    expect(vc.storage_stem).toBe(created.storageStem);
    expect(vc.start_offset_ms).toBe(0);
    expect(vc.end_offset_ms).toBeGreaterThan(80_000); // duration = end - start
    expect(vc.end_offset_ms).toBeLessThan(95_000);
    expect(Number(vc.file_size)).toBe(totalBytes);

    // clip raw object sits at the returned stem
    const rawStat = await minio.statObject(env.BUCKET_RAW, `${created.storageStem}.ts`);
    expect(rawStat.size).toBe(totalBytes);

    // clip artifacts mint and fetch — the finalize pipeline ran for the clip
    const arts = (
      await json(await fetch(`${server.baseUrl}/api/minio_handler/sessions/${created.id}/artifacts`))
    ).data;
    for (const url of [arts.hls.manifest, arts.hls.media, arts.mkv, arts.thumbnail]) {
      const res = await fetch(url);
      expect(res.status, url).toBe(200);
    }

    // cleanup: raw clip + four artifacts
    const clipStem = created.storageStem as string;
    await minio.removeObject(env.BUCKET_RAW, `${clipStem}.ts`);
    await minio.removeObject(env.BUCKET_MEDIA, `${clipStem}/video.mkv`);
    await minio.removeObject(env.BUCKET_MEDIA, `${clipStem}/hls/index.m3u8`);
    await minio.removeObject(env.BUCKET_MEDIA, `${clipStem}/hls/media.ts`);
    await minio.removeObject(env.BUCKET_THUMBNAILS, `${clipStem}/poster.jpg`);
  },
  120_000,
);
