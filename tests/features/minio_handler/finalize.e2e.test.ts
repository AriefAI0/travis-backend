import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { generateSegments } from "../../helpers/fixtures";
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

async function pollStatus(id: string, want: (d: any) => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const data = await (await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`)).json();
    if (want(data.data)) return data.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`status did not reach expected state within ${ms}ms`);
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
  server = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
}, 120_000);

afterAll(async () => {
  await server?.stop().catch(() => {});
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(SEG_DIR, { recursive: true, force: true });
});

test(
  "stop finalizes into mkv + single-file hls + thumbnail; artifact URLs fetch 200",
  async () => {
    const create = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSessionId: "session-e2e-finalize", kind: "master" }),
    });
    expect(create.status).toBe(201);
    const id = (await create.json()).data.id as string;

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

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    const stopBody = await stopRes.text();
    expect(stopRes.status, stopBody).toBe(202);

    const final = await pollStatus(id, (d) => d.status === "finalized", 120_000);
    expect(final.artifactStatus).toBe("ready");

    // presigned URLs from the artifacts route, all fetchable
    const artsRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/artifacts`);
    expect(artsRes.status).toBe(200);
    const arts = (await artsRes.json()).data;
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

    // cleanup all five objects (raw master + four artifacts)
    await minio.removeObject(env.BUCKET_MASTER, `recordings/${id}/master.ts`);
    await minio.removeObject(env.BUCKET_MKV, `${id}.mkv`);
    await minio.removeObject(env.BUCKET_HLS, `${id}/index.m3u8`);
    await minio.removeObject(env.BUCKET_HLS, `${id}/media.ts`);
    await minio.removeObject(env.BUCKET_THUMBNAILS, `${id}.jpg`);
  },
  180_000,
);
