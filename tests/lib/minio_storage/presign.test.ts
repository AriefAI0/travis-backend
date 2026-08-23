import { expect, test } from "bun:test";
// region is pinned in buildMinioClient, so presigning signs offline — no MinIO needed.
import {
  PART_UPLOAD_TTL_SECONDS,
  PROBE_TTL_SECONDS,
  presignPartUpload,
  presignPutObject,
} from "../../../src/lib/minio_storage/s3sdk";

test("part-upload ticket targets the MPU part with a 5-minute expiry", async () => {
  const url = await presignPartUpload("travis-raw", "some/base/master.ts", "upload-1", 3);
  expect(url).toContain("travis-raw/some/base/master.ts");
  expect(url).toContain("partNumber=3");
  expect(url).toContain("uploadId=upload-1");
  expect(url).toContain(`X-Amz-Expires=${PART_UPLOAD_TTL_SECONDS}`);
  expect(PART_UPLOAD_TTL_SECONDS).toBe(300);
});

test("probe ticket is a plain PUT with a 1-minute expiry", async () => {
  const url = await presignPutObject("travis-raw", "_preflight/abc");
  expect(url).toContain("travis-raw/_preflight/abc");
  expect(url).not.toContain("partNumber=");
  expect(url).toContain(`X-Amz-Expires=${PROBE_TTL_SECONDS}`);
  expect(PROBE_TTL_SECONDS).toBe(60);
});
