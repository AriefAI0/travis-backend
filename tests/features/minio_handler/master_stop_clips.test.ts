import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import pg from "pg";
import { env } from "../../../src/config/env";
import { json } from "../../helpers/json";
import { seedRecordingHierarchy, type SeededHierarchy } from "../../helpers/seed";
import { startServer, type TestServer } from "../../helpers/server";

const DATA_DIR = "./data/test-master-stop-clips";

let server: TestServer;
let seed: SeededHierarchy;
let pool: pg.Pool;

beforeAll(async () => {
  seed = await seedRecordingHierarchy();
  server = await startServer({ PART_SIZE_BYTES: String(5 * 1024 * 1024), DATA_DIR });
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await seed?.cleanup();
  await pool?.end();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function createRecording(body: Record<string, unknown>) {
  const res = await fetch(`${server.baseUrl}/api/minio_handler/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await json<{ data: { id: string } }>(res)).data;
}

// read the one clip row of a result straight from Postgres
async function clipRowOf(resultId: number) {
  const { rows } = await pool.query(
    "select clip_id, recording_status, storage_stem from video_clip where result_id = $1",
    [resultId],
  );
  return rows[0] ?? null;
}

test(
  "stopping the master closes its still-recording clip, row survives",
  async () => {
    const master = await createRecording({
      kind: "master",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
    });
    const clip = await createRecording({
      kind: "clip",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
      itemId: seed.itemId,
      resultId: seed.resultId,
    });

    expect((await clipRowOf(seed.resultId)).recording_status).toBe("recording");

    const stop = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${master.id}/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(202);

    // clip row: closed, NOT deleted, stem intact — images still resolve
    const row = await clipRowOf(seed.resultId);
    expect(row).not.toBeNull();
    expect(row.recording_status).toBe("finalization_failed");
    expect(row.storage_stem).toContain("GVI/clip_");
  },
  60_000,
);

test(
  "an already-closed clip is never re-marked by the master stop",
  async () => {
    const master = await createRecording({
      kind: "master",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
    });
    const clip = await createRecording({
      kind: "clip",
      projectId: seed.projectId,
      sessionId: seed.sessionId,
      itemId: seed.itemId,
      resultId: seed.resultId,
    });

    // clip finished on its own: finalized before the master stops
    await pool.query("update video_clip set recording_status = 'finalized' where result_id = $1", [
      seed.resultId,
    ]);

    const stop = await fetch(`${server.baseUrl}/api/minio_handler/sessions/${master.id}/stop`, {
      method: "POST",
    });
    expect(stop.status).toBe(202);

    expect((await clipRowOf(seed.resultId)).recording_status).toBe("finalized");
  },
  60_000,
);
