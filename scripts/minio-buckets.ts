// Interactive bucket deletion tool (dev use only).
// flow: list buckets > pick > confirm > empty if needed > delete > summary
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  outro,
  spinner,
} from "@clack/prompts";
import { minio } from "../src/lib/minio_storage/clients";
import { buckets } from "../src/config/env";

// MinIO caps bulk delete at 1000 keys per request
const DELETE_BATCH = 1000;

// exit cleanly when any prompt is cancelled (ESC / Ctrl-C)
function bail(value: unknown): asserts value {
  if (isCancel(value)) {
    cancel("aborted, nothing was deleted");
    process.exit(0);
  }
}

// app-seeded buckets get a marker in the picker
function labelFor(name: string): string {
  return buckets.includes(name) ? `${name} (app)` : name;
}

// stream-count every object in a bucket, recursive
async function countObjects(bucket: string): Promise<number> {
  let count = 0;
  for await (const _ of minio.listObjects(bucket, "", true)) count++;
  return count;
}

// flow: stream names > batch 1000 > removeObjects > report progress
async function emptyBucket(bucket: string, total: number): Promise<void> {
  let removed = 0;
  let batch: string[] = [];
  for await (const obj of minio.listObjects(bucket, "", true)) {
    if (!obj.name) continue;
    batch.push(obj.name);
    if (batch.length < DELETE_BATCH) continue;
    await minio.removeObjects(bucket, batch);
    removed += batch.length;
    log.step(`${bucket}: removed ${removed}/${total}`);
    batch = [];
  }
  if (batch.length > 0) {
    await minio.removeObjects(bucket, batch);
    removed += batch.length;
    log.step(`${bucket}: removed ${removed}/${total}`);
  }
}

// flow: count > force-empty confirm > empty > removeBucket
async function deleteBucket(bucket: string): Promise<"deleted" | "skipped"> {
  const spin = spinner();
  spin.start(`scanning ${bucket}`);
  let count: number;
  try {
    count = await countObjects(bucket);
    spin.stop(`${bucket}: ${count} object(s)`);
  } catch (err) {
    spin.stop(`failed to scan ${bucket}`, 1);
    throw err;
  }

  if (count > 0) {
    const empty = await confirm({
      message: `${bucket} holds ${count} object(s). delete them all? (no = skip bucket)`,
    });
    bail(empty);
    if (!empty) return "skipped";
    await emptyBucket(bucket, count);
  }

  await minio.removeBucket(bucket);
  return "deleted";
}

// flow: list > multiselect > confirm > delete each > summary
async function main(): Promise<void> {
  intro("minio bucket tools");

  const spin = spinner();
  spin.start("listing buckets");
  const all = await minio.listBuckets();
  spin.stop(`found ${all.length} bucket(s)`);
  if (all.length === 0) {
    outro("no buckets to delete");
    return;
  }

  const selected = await multiselect({
    message: "buckets to delete (space selects, enter confirms)",
    options: [...all]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({
        value: b.name,
        label: labelFor(b.name),
        hint: `created ${b.creationDate.toISOString().slice(0, 10)}`,
      })),
  });
  bail(selected);
  if (selected.length === 0) {
    outro("nothing selected");
    return;
  }

  // warn harder when app buckets are in the selection
  const appHits = selected.filter((n) => buckets.includes(n));
  const warn = appHits.length
    ? ` -- includes app buckets (${appHits.join(", ")}), the server re-creates them at boot`
    : "";
  const sure = await confirm({
    message: `permanently delete ${selected.length} bucket(s): ${selected.join(", ")}${warn}?`,
  });
  bail(sure);
  if (!sure) {
    outro("aborted, nothing was deleted");
    return;
  }

  const deleted: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const bucket of selected) {
    try {
      const result = await deleteBucket(bucket);
      if (result === "deleted") deleted.push(bucket);
      else skipped.push(bucket);
    } catch (err) {
      failed.push(bucket);
      log.error(`${bucket}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info(`deleted: ${deleted.length ? deleted.join(", ") : "none"}`);
  if (skipped.length) log.warn(`skipped, still holds objects: ${skipped.join(", ")}`);
  if (failed.length) log.error(`failed: ${failed.join(", ")}`);
  outro("done");
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
