import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { json } from "../../helpers/json";
import { startServer, type TestServer } from "../../helpers/server";

// Direct-upload transport contract: the test IS the app — reserve a part,
// PUT real bytes straight to MinIO, report the ETag, stop, verify the master.
// Small stale window so the resume test flips in seconds, not 30s.
const MB = 1024 * 1024;
const DATA_DIR = "C:/Users/arief/AppData/Local/Temp/travis-e2e-direct";
let server: TestServer;

// random payload: etags must differ between parts (MinIO etags are content md5s)
function payload(seed: number, size = 5 * MB): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let off = 0; off < size; off += 65536) {
    const block = crypto.getRandomValues(new Uint8Array(Math.min(65536, size - off)));
    bytes.set(block, off);
  }
  bytes[0] = seed; // guarantee inter-part difference even on rng collision
  return bytes;
}

async function createSession(kind: "master" | "clip", n: number) {
  const body =
    kind === "master"
      ? { kind, projectId: 1, sessionId: 1, recordingId: 9000 + n }
      : { kind, projectId: 1, sessionId: 1, itemId: 1, clipId: 9000 + n };
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await json(res)).data;
}

async function reserve(id: string) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/parts`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await json(res)).data;
}

async function complete(id: string, partNumber: number, body: unknown) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/parts/${partNumber}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await json(res) };
}

async function getStatus(id: string) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}`);
  return (await json(res)).data;
}

// poll until the session leaves 'finalizing' — finalized (ffmpeg present) or
// finalization_failed (ffmpeg missing) both prove the terminal-state contract
async function awaitTerminal(id: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = (await getStatus(id)).status;
    if (status === "finalized" || status === "finalization_failed") return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`session ${id} never left finalizing`);
}

beforeAll(async () => {
  server = await startServer({
    MINIO_ENDPOINT: "http://localhost:9002",
    DATA_DIR,
    SEGMENT_STALE_SECONDS: "2",
    MAX_ACTIVE_SESSIONS: "10",
    PART_SIZE_BYTES: String(5 * MB),
  });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test(
  "probe + reserve + PUT + complete + stop sews exact bytes into one master",
  async () => {
    const created = await createSession("master", 1);
    const id = created.id;
    expect(created.status).toBe("recording");
    expect(created.partSizeBytes).toBe(5 * MB);
    expect(created.probeUrl).toBeTruthy();

    // arm-time probe: app PUTs 16 bytes directly to MinIO
    const probe = await fetch(created.probeUrl, { method: "PUT", body: new Uint8Array(16) });
    expect(probe.status).toBe(200);

    // two 5 MiB parts uploaded straight to MinIO via presigned tickets
    const parts: { bytes: Uint8Array; etag: string }[] = [];
    for (let n = 1; n <= 2; n++) {
      const ticket = await reserve(id);
      expect(ticket.partNumber).toBe(n);
      expect(ticket.expiresInSeconds).toBe(300);

      const bytes = payload(n);
      const put = await fetch(ticket.url, { method: "PUT", body: bytes });
      expect(put.status).toBe(200);
      const etag = put.headers.get("etag");
      expect(etag).toBeTruthy();

      // covers segments (n-1)*16 .. n*16-1
      const res = await complete(id, n, {
        etag,
        firstIndex: (n - 1) * 16,
        lastIndex: n * 16 - 1,
        sizeBytes: bytes.byteLength,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.durableThrough).toBe(n * 16 - 1);
      expect(res.body.data.nextPartNumber).toBe(n + 1);
      parts.push({ bytes, etag: etag! });
    }

    // reserve stickiness over the wire: counter is past these parts now, so
    // both calls must return the SAME next number (3) with fresh tickets
    const again1 = await reserve(id);
    const again2 = await reserve(id);
    expect(again1.partNumber).toBe(3);
    expect(again2.partNumber).toBe(3);

    const stopRes = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    expect(stopRes.status).toBe(202);
    expect((await json(stopRes)).data.status).toBe("finalizing");

    // exactly ONE master object holds every uploaded byte, in order
    const base = `projects/1/sessions/1/recordings/9001`;
    const key = `${base}/master.ts`;
    const stat = await minio.statObject(env.BUCKET_RAW, key);
    const total = parts.reduce((n, p) => n + p.bytes.byteLength, 0);
    expect(stat.size).toBe(total);

    const objectBytes = new Uint8Array(await new Response(await minio.getObject(env.BUCKET_RAW, key)).arrayBuffer());
    const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
    const expected = new Uint8Array(total);
    parts.forEach((p, i) => expected.set(p.bytes, i * p.bytes.byteLength));
    expect(sha(objectBytes)).toBe(sha(expected));

    // terminal, never stuck: finalized (ffmpeg present) or finalization_failed
    const terminal = await awaitTerminal(id);
    expect(["finalized", "finalization_failed"]).toContain(terminal);

    await minio.removeObject(env.BUCKET_RAW, key);
  },
  180_000,
);

test(
  "error contract over the wire: out_of_order and small_part carry resync details",
  async () => {
    const created = await createSession("master", 2);
    const id = created.id;

    const bytes = payload(3);
    const ticket = await reserve(id);
    const put = await fetch(ticket.url, { method: "PUT", body: bytes });
    expect(put.status).toBe(200);
    const okComplete = await complete(id, 1, { etag: put.headers.get("etag"), firstIndex: 0, lastIndex: 15, sizeBytes: bytes.byteLength });
    expect(okComplete.status).toBe(200);

    // gap: durableThrough is 15, so firstIndex 17 must be rejected with resync info
    const gap = await complete(id, 2, { etag: '"fake"', firstIndex: 17, lastIndex: 31, sizeBytes: 5 * MB });
    expect(gap.status).toBe(409);
    expect(gap.body.code).toBe("out_of_order");
    expect(gap.body.durableThrough).toBe(15);

    // under-minimum part during recording
    const small = await complete(id, 2, { etag: '"fake"', firstIndex: 16, lastIndex: 20, sizeBytes: 4 * MB });
    expect(small.status).toBe(400);
    expect(small.body.code).toBe("small_part");
    expect(small.body.minimum).toBe(5 * MB);

    await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    await awaitTerminal(id);
    await minio.removeObject(env.BUCKET_RAW, `projects/1/sessions/1/recordings/9002/master.ts`);
  },
  60_000,
);

test(
  "heartbeat silence goes stale; first reserve resumes",
  async () => {
    const created = await createSession("clip", 3);
    const id = created.id;

    // SEGMENT_STALE_SECONDS=2: no heartbeat for ~4s flips the session stale
    await new Promise((r) => setTimeout(r, 4000));
    expect((await getStatus(id)).status).toBe("stale");

    const ticket = await reserve(id); // resume on first reserve after idle
    expect(ticket.partNumber).toBe(1);
    expect((await getStatus(id)).status).toBe("recording");

    await fetch(`${server.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
    await awaitTerminal(id);
  },
  60_000,
);
