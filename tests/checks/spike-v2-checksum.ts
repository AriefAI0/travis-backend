// One-off capability spike for the v2 segment protocol: does this MinIO
// enforce sha-256 checksums on presigned PUTs (header or query-bound), and
// does statObject expose the stored checksum? Decides the completion path:
// storage-enforced (stat + size) vs backend fetch-and-hash. Safe to delete
// once the decision is recorded.
import { createHash, randomBytes } from "node:crypto";

import { env } from "../../src/config/env";
import { buildMinioClient } from "../../src/lib/minio_storage/clients";

const client = buildMinioClient(env.MINIO_ENDPOINT, env.MINIO_ACCESS_KEY, env.MINIO_SECRET_KEY);
const bucket = env.BUCKET_RAW;
const run = `spike/v2-checksum-${Date.now()}`;

const put = async (url: string, body: Uint8Array, headers: Record<string, string> = {}) => {
  const res = await fetch(url, { method: "PUT", body: body, headers });
  return res.status;
};

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest();

const bodyA = randomBytes(64);
const bodyB = randomBytes(64);
const checksumA = b64(digest(bodyA));
const checksumB = b64(digest(bodyB));

// 1. baseline: plain presigned PUT, no checksum involvement
const baseUrl = await client.presignedUrl("PUT", bucket, `${run}/plain.bin`, 300);
console.log("1. plain presigned PUT:", await put(baseUrl, bodyA));

// 2. checksum HEADER only (unsigned header, presigned URL has no query param):
//    matching then mismatching. A mismatch rejection means MinIO validates
//    the header whenever present — storage-enforced path works.
const headerUrl = await client.presignedUrl("PUT", bucket, `${run}/header.bin`, 300);
console.log("2a. PUT header matching:", await put(headerUrl, bodyA, { "x-amz-checksum-sha256": checksumA }));
console.log("2b. PUT header mismatch:", await put(headerUrl + ".mm", bodyA, { "x-amz-checksum-sha256": checksumB }));

// 3. checksum bound as signed QUERY param, header mismatching it. A mismatch
//    rejection means the query binding enforces the value.
const queryUrl = await client.presignedUrl("PUT", bucket, `${run}/query.bin`, 300, {
  "x-amz-checksum-sha256": checksumA,
});
console.log("3a. PUT query-bound matching:", await put(queryUrl, bodyA, { "x-amz-checksum-sha256": checksumA }));
const queryUrl2 = await client.presignedUrl("PUT", bucket, `${run}/query2.bin`, 300, {
  "x-amz-checksum-sha256": checksumA,
});
console.log("3b. PUT query-bound mismatch:", await put(queryUrl2, bodyB, { "x-amz-checksum-sha256": checksumB }));
const queryUrl3 = await client.presignedUrl("PUT", bucket, `${run}/query3.bin`, 300, {
  "x-amz-checksum-sha256": checksumA,
});
console.log("3c. PUT query-bound, header omitted:", await put(queryUrl3, bodyB));

// 4. does statObject expose the stored checksum in metadata?
const stat = await client.statObject(bucket, `${run}/header.bin`);
console.log("4. stat meta keys:", Object.keys(stat.metaData ?? {}));
console.log("4. stat meta:", JSON.stringify(stat.metaData));
console.log("4. etag:", stat.etag);
