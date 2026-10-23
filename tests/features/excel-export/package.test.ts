import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import { readmeEntry, textEntry, writePackage, type PackageEntry } from "../../../src/features/excel-export/package";

// the packager talks to the real bucket; skip the file when MinIO is down
const reachable = await minio
  .bucketExists(env.BUCKET_MEDIA)
  .catch(() => false);

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const key = (name: string) => `excel-exports/test/${suffix}-${name}`;
const written: string[] = [];

afterAll(async () => {
  for (const objectKey of written) {
    await minio.removeObject(env.BUCKET_MEDIA, objectKey).catch(() => {});
  }
});

// a zero stream of a known length, generated so nothing is held in memory
const zeros = (bytes: number) =>
  Readable.from(
    (async function* () {
      const chunk = Buffer.alloc(1024 * 1024);
      let left = bytes;
      while (left > 0) {
        const size = Math.min(left, chunk.length);
        yield chunk.subarray(0, size);
        left -= size;
      }
    })(),
  );

const readBack = async (objectKey: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "package-read-"));
  const file = path.join(directory, "package.zip");
  const stream = await minio.getObject(env.BUCKET_MEDIA, objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  await writeFile(file, Buffer.concat(chunks));

  const child = Bun.spawn(["unzip", "-l", file], { stdout: "pipe", stderr: "pipe" });
  const listing = await new Response(child.stdout).text();
  await child.exited;
  await rm(directory, { recursive: true, force: true });
  return listing;
};

describe.skipIf(!reachable)("excel export package", () => {
  it("stores the entries in order, README first and workbook last", async () => {
    const objectKey = key("order.zip");
    written.push(objectKey);

    const directory = await mkdtemp(path.join(tmpdir(), "package-src-"));
    const workbook = path.join(directory, "workbook.xlsx");
    await writeFile(workbook, "workbook bytes");

    const entries: PackageEntry[] = [
      readmeEntry(["Extract this zip first."]),
      textEntry("images/GVI/1_1.jpg", "image bytes"),
      { name: "workbook.xlsx", open: () => Readable.from(Bun.file(workbook).stream()) },
    ];

    const result = await writePackage(objectKey, entries);
    await rm(directory, { recursive: true, force: true });

    expect(result.bytes).toBeGreaterThan(0);

    const listing = await readBack(objectKey);
    expect(listing).toContain("README.txt");
    expect(listing).toContain("images/GVI/1_1.jpg");
    expect(listing).toContain("workbook.xlsx");
    expect(listing.indexOf("README.txt")).toBeLessThan(listing.indexOf("workbook.xlsx"));
  }, 60_000);

  it("packages 200 MiB of entries at a flat memory cost", async () => {
    const objectKey = key("big.zip");
    written.push(objectKey);

    Bun.gc(true);
    const before = process.memoryUsage().rss;

    // the peak matters, not what the allocator keeps afterwards
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);

    const result = await writePackage(objectKey, [
      readmeEntry(["two hundred megabytes"]),
      { name: "media/big.bin", open: () => zeros(200 * 1024 ** 2) },
    ]);

    clearInterval(sampler);
    const growth = peak - before;

    expect(result.bytes).toBeGreaterThan(200 * 1024 ** 2);
    // one 64 MiB part plus slack, not the whole package
    expect(growth).toBeLessThan(150 * 1024 ** 2);
  }, 180_000);

  it("removes the incomplete upload when the signal aborts", async () => {
    const objectKey = key("aborted.zip");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const run = writePackage(
      objectKey,
      [readmeEntry(["aborted"]), { name: "media/big.bin", open: () => zeros(64 * 1024 ** 2) }],
      { signal: controller.signal },
    );

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    // nothing half-written is left behind
    await expect(minio.statObject(env.BUCKET_MEDIA, objectKey)).rejects.toBeDefined();
  }, 60_000);
});
