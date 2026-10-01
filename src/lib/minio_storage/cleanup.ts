// Best-effort removal of stored media. Every caller runs this AFTER its DB
// commit, so a storage error must log and let the request succeed: the rows are
// already gone and a retry would find nothing to key off.
// flow: collect keys > commit rows > remove objects > log on failure

import { env } from "../../config/env";
import { log } from "../logger";
import { minio } from "./clients";

// every object under one prefix: an ingest writes segments, poster and evidence
// images beneath the prefix it froze at admission
export async function removeMediaPrefix(keyPrefix: string): Promise<void> {
  try {
    const objects = minio.listObjects(env.BUCKET_MEDIA, keyPrefix, true);
    const keys: string[] = [];
    for await (const obj of objects) {
      if (obj.name) keys.push(obj.name);
    }
    if (keys.length > 0) await minio.removeObjects(env.BUCKET_MEDIA, keys);
  } catch (err) {
    log.warn("media prefix cleanup failed", { keyPrefix, err: String(err) });
  }
}

// exact leaves, for rows that store their own key (evidence images, posters)
export async function removeMediaKeys(keys: string[]): Promise<void> {
  const wanted = keys.filter((key) => key.length > 0);
  if (wanted.length === 0) return;

  try {
    await minio.removeObjects(env.BUCKET_MEDIA, wanted);
  } catch (err) {
    log.warn("media key cleanup failed", { count: wanted.length, err: String(err) });
  }
}
