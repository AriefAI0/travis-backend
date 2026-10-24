import { describe, expect, test } from "bun:test";

import { matchesImageMagic } from "../../src/lib/minio_storage/result-image-objects";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = Buffer.from("RIFF0000WEBP", "ascii");

describe("admin image magic bytes", () => {
  test("accepts a matching declared type", () => {
    expect(matchesImageMagic(png, "image/png")).toBe(true);
    expect(matchesImageMagic(jpeg, "image/jpeg")).toBe(true);
    expect(matchesImageMagic(webp, "image/webp")).toBe(true);
  });

  test("rejects a content type that disagrees with the bytes", () => {
    expect(matchesImageMagic(png, "image/jpeg")).toBe(false);
    expect(matchesImageMagic(jpeg, "image/png")).toBe(false);
    expect(matchesImageMagic(Buffer.from("not an image"), "image/webp")).toBe(false);
  });

  test("rejects an unknown content type", () => {
    expect(matchesImageMagic(png, "image/gif")).toBe(false);
  });
});
