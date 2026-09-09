// One-shot cleanup for process-kill drill objects in the shared MinIO
// buckets. Deletes ONLY the recording prefixes named on the command line:
//   docker run --rm --network travis -v /home/linux_master/travis-backend:/repo \
//     -w /repo travis-backend:dev bun tests/checks/cleanup-drill-objects.ts <uuid> [<uuid>...]
import { minio } from "../../src/lib/minio_storage/clients";
import { env } from "../../src/config/env";

const recordingIds = process.argv.slice(2);
if (recordingIds.length === 0) {
  console.error("usage: bun tests/checks/cleanup-drill-objects.ts <recordingId> [...]");
  process.exit(1);
}

for (const recordingId of recordingIds) {
  if (!/^[0-9a-f-]{36}$/i.test(recordingId)) {
    throw new Error(`not a uuid: ${recordingId}`);
  }
  for (const bucket of [env.BUCKET_RAW, env.BUCKET_MEDIA]) {
    // recursive list: non-recursive listing yields prefix groupings with no name
    const objects: Array<{ name?: string }> = [];
    for await (const item of minio.listObjects(bucket, `recordings/${recordingId}/`, true)) {
      objects.push(item);
    }
    const keys = objects.map((o) => o.name).filter((n): n is string => Boolean(n));
    if (keys.length > 0) {
      await minio.removeObjects(bucket, keys);
      console.log(`removed ${keys.length} objects from ${bucket} for ${recordingId}`);
    } else {
      console.log(`nothing under ${bucket}/recordings/${recordingId}/`);
    }
  }
}
