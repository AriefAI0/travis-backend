// One-off repro: SIGKILL mid-recording, restart, re-send, stop — dump tracker at each step.
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { rawLeaf } from "../../src/features/minio_handler/paths";
import { minio } from "../../src/lib/minio_storage/clients";
import { seedRecordingHierarchy } from "../helpers/seed";
import { startServer } from "../helpers/server";
import { json } from "../helpers/json";

const DATA_DIR = "./data/spike-crash";
rmSync(DATA_DIR, { recursive: true, force: true });

const seg = new Uint8Array(1024 * 1024); // 1MB segments, part cutting needs no real media
const PART = String(5 * 1024 * 1024);

function dump(label: string) {
  const db = new Database(`${DATA_DIR}/tracker.sqlite3`, { readonly: true });
  console.log(label, "parts:", JSON.stringify(db.query("SELECT part_number, first_idx, last_idx, size_bytes FROM parts").all()));
  console.log(label, "session:", JSON.stringify(db.query("SELECT status, durable_through, substr(upload_id,1,10) AS up FROM sessions").all()));
  db.close();
}

// create needs a real session row: the server reads the project off it
const seed = await seedRecordingHierarchy();
console.log("seeded: project", seed.projectId, "session", seed.sessionId);

const s1 = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
const create = await fetch(`${s1.baseUrl}/api/minio_handler/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "master", projectId: seed.projectId, sessionId: seed.sessionId }),
});
if (create.status !== 201) throw new Error(`create failed: ${create.status} ${await create.text()}`);
const ticket = (await json<{ data: { id: string; storageStem: string } }>(create)).data;
const id = ticket.id;

let durable = -1;
for (let i = 0; durable < 0; i++) {
  const res = await fetch(`${s1.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, { method: "POST", body: seg });
  durable = (await json<{ data: { durableThrough: number } }>(res)).data.durableThrough;
  console.log("s1 seg", i, "-> durable", durable);
}
dump("after-send");
s1.kill();
dump("after-kill");

const s2 = await startServer({ PART_SIZE_BYTES: PART, DATA_DIR });
const st = await json<any>(await fetch(`${s2.baseUrl}/api/minio_handler/sessions/${id}`));
console.log("after-restart status:", JSON.stringify(st.data));
dump("after-reconcile");

for (let i = durable + 1; i < 12; i++) {
  const res = await fetch(`${s2.baseUrl}/api/minio_handler/sessions/${id}/segments?index=${i}`, { method: "POST", body: seg });
  const body = await json<any>(res);
  if (!res.ok) console.log("RESEND FAIL", i, res.status, JSON.stringify(body));
  else console.log("s2 seg", i, "-> durable", body.data.durableThrough);
}
dump("after-resend");

const stop = await fetch(`${s2.baseUrl}/api/minio_handler/sessions/${id}/stop`, { method: "POST" });
console.log("stop:", stop.status, await stop.text());
dump("after-stop");

// remove the zeros master object — its finalize job would fail on non-media bytes anyway
const raw = rawLeaf(ticket.storageStem);
await minio.removeObject(raw.bucket, raw.key);

await s2.stop();
// this repro is throwaway state: drop the seeded rows
await seed.cleanup();
rmSync(DATA_DIR, { recursive: true, force: true });
