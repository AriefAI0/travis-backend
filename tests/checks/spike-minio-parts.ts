// Spike: can the minio SDK drive MANUAL multipart ops via presignedUrl? (spec D8)
// Proves: initiate, part-scoped PUT (ETag header!), ListParts, Complete, against live MinIO.
import { minio } from "../../src/lib/minio_storage/clients";
import { env } from "../../src/config/env";

const bucket = env.BUCKET_RAW;
const key = `spikes/spike-minio-parts-${Date.now()}.ts`;
const c = minio as any;

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:[a-z]+:)?${name}>([^<]+)<`));
  return m?.[1] ?? "";
}

// 1. initiate: POST ?uploads
const initiateUrl: string = await c.presignedUrl("POST", bucket, key, 60, { uploads: "" });
console.log("initiate URL ok:", initiateUrl.includes("uploads="));
const initiateRes = await fetch(initiateUrl, { method: "POST" });
const initiateXml = await initiateRes.text();
console.log("initiate status:", initiateRes.status);
const uploadId = tag(initiateXml, "UploadId");
console.log("uploadId:", uploadId.slice(0, 12) + "...");

// 2. upload part 1 (5MB, meets min-size) via presigned PUT — ETag from response header (audit F1)
const partUrl: string = await c.presignedUrl("PUT", bucket, key, 60, { partNumber: "1", uploadId });
const partBody = new Uint8Array(5 * 1024 * 1024).fill(7);
const partRes = await fetch(partUrl, { method: "PUT", body: partBody });
const etag1 = partRes.headers.get("etag") ?? "";
console.log("part1 status:", partRes.status, "| etag header:", etag1);

// 3. upload part 2 (smaller — last part may be < 5MB)
const part2Url: string = await c.presignedUrl("PUT", bucket, key, 60, { partNumber: "2", uploadId });
const part2Res = await fetch(part2Url, { method: "PUT", body: new Uint8Array(1024 * 1024).fill(9) });
const etag2 = part2Res.headers.get("etag") ?? "";
console.log("part2 status:", part2Res.status, "| etag header:", etag2);

// 4. ListParts
const listUrl: string = await c.presignedUrl("GET", bucket, key, 60, { uploadId });
const listRes = await fetch(listUrl);
const listXml = await listRes.text();
console.log("listParts status:", listRes.status, "| parts listed:", (listXml.match(/<Part>/g) ?? []).length);

// 5. Complete
const completeXmlBody = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`;
const completeUrl: string = await c.presignedUrl("POST", bucket, key, 60, { uploadId });
const completeRes = await fetch(completeUrl, { method: "POST", body: completeXmlBody });
console.log("complete status:", completeRes.status, (await completeRes.text()).slice(0, 120));

// 6. verify object + cleanup
const stat = await minio.statObject(bucket, key);
console.log("object size:", stat.size, "(expect", 6 * 1024 * 1024 + ")");
await minio.removeObject(bucket, key);
console.log("cleanup done");
