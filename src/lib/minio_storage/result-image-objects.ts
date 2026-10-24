// Exact-key evidence object work: strict removal and the first-byte check.
// Project and archive cleanup keep their best-effort helper.

import { env } from "../../config/env";
import { minio } from "./clients";

export const MAX_ADMIN_IMAGE_BYTES = 20 * 1024 * 1024;

// Remove only the supplied leaves. A missing object is already removed; a real
// per-key error throws so the caller keeps the image row for a safe retry.
export async function removeExactMediaKeys(keys: string[]): Promise<void> {
  const wanted = [...new Set(keys.filter((key) => key.length > 0))];
  if (wanted.length === 0) return;

  const results = await minio.removeObjects(env.BUCKET_MEDIA, wanted);
  const failed = results.filter((result) => result?.Error);
  if (failed.length > 0) {
    const first = failed[0]!.Error!;
    throw new Error(
      `image object removal failed at ${first.Key}: ${first.Message ?? first.Code ?? "unknown error"}`,
    );
  }
}

// Read at most `length` bytes from the object head.
export async function readObjectHead(
  bucket: string,
  key: string,
  length = 12,
): Promise<Buffer> {
  const stream = await minio.getPartialObject(bucket, key, 0, length);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk as Buffer);
      chunks.push(buffer);
      total += buffer.length;
      if (total >= length) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, length);
}

const startsWith = (bytes: Buffer, expected: number[]): boolean =>
  bytes.length >= expected.length &&
  expected.every((value, index) => bytes[index] === value);

// PNG, JPEG, and WebP magic bytes. The declared content type must agree.
export function matchesImageMagic(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (contentType === "image/jpeg") {
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  }
  if (contentType === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}
