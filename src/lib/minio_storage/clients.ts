import { Client } from "minio";
import { buckets, env } from "../../config/env";

// Ported from the travis app's scripts/minio-mint-service.ts buildMinioClient.
// `partSize` matters for a streamed upload with no known length: unset, minio-js
// assumes a 5 TiB object and buffers a 528 MiB part in memory.
export function buildMinioClient(
  endpoint: string,
  accessKey: string,
  secretKey: string,
  partSize?: number,
) {
  const url = new URL(endpoint);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey,
    secretKey,
    ...(partSize ? { partSize } : {}),
    // pin the region: presigning stays offline (unset, minio-js does a
    // GetBucketLocation round-trip per first presign per bucket)
    region: "us-east-1",
  });
}

export const minio = buildMinioClient(env.MINIO_ENDPOINT, env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY);

export async function ensureBuckets(client: Client = minio) {
  for (const bucket of buckets) {
    if (!(await client.bucketExists(bucket))) {
      await client.makeBucket(bucket);
    }
  }
}
