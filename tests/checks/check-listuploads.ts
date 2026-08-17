// One-off: prove listUploads parses a NON-empty listing (orphan-sweep dependency).
import { env } from "../../src/config/env";
import { s3parts } from "../../src/lib/minio_storage/s3sdk";

const key = "spikes/list-uploads/master.ts";
const uploadId = await s3parts.initiate(env.BUCKET_RAW, key);

let ups = await s3parts.listUploads(env.BUCKET_RAW);
console.log("after initiate:", JSON.stringify(ups));
if (!ups.some((u) => u.uploadId === uploadId && u.key === key)) throw new Error("listing did not include the live MPU");

await s3parts.abort(env.BUCKET_RAW, key, uploadId);
ups = await s3parts.listUploads(env.BUCKET_RAW);
console.log("after abort:", JSON.stringify(ups));
if (ups.some((u) => u.uploadId === uploadId)) throw new Error("aborted MPU still listed");
console.log("OK: non-empty listUploads parsing proven");
