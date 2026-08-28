// probe: does the finalized+stem gate imply the poster object exists?
import { db } from "./src/db/client";
import { minio } from "./src/lib/minio_storage/clients";
import { clipLeaves } from "./src/lib/minio_storage/paths";

const q = async (sql: string) =>
  (await db.execute(sql as never)) as unknown as { rows: Record<string, unknown>[] };

const check = async (label: string, rows: Record<string, unknown>[]) => {
  let present = 0;
  const missing: string[] = [];
  for (const r of rows) {
    const stem = String(r.storage_stem);
    const leaf = clipLeaves(stem).poster;
    try {
      await minio.statObject(leaf.bucket, leaf.key);
      present++;
    } catch {
      missing.push(`${r.id} ${stem}`);
    }
  }
  console.log(`${label}: gate-passes=${rows.length} poster-present=${present} poster-MISSING=${missing.length}`);
  missing.slice(0, 6).forEach((m) => console.log("   missing:", m));
};

await check(
  "MASTERS",
  (await q(
    "select master_video_id as id, storage_stem from master_video where recording_status = 'finalized' and storage_stem is not null",
  )).rows,
);
await check(
  "CLIPS",
  (await q(
    "select clip_id as id, storage_stem from video_clip where recording_status = 'finalized' and storage_stem is not null",
  )).rows,
);
process.exit(0);
