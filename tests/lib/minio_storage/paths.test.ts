import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import * as schema from "../../../src/db/schema";
import {
  clipSegmentLeaf,
  exportLeaf,
  filmstripLeaf,
  masterSegmentLeaf,
  mediaDatePath,
  mediaPrefix,
  posterLeaf,
  resolveOrganizationId,
  resultImageLeaves,
  type MediaScope,
} from "../../../src/lib/minio_storage/paths";

// one second before midnight UTC: the key date must stay 2026-09-20
const SCOPE: MediaScope = {
  organizationId: 1,
  projectId: 3,
  sessionId: 12,
  startedAt: new Date("2026-09-20T23:59:59.000Z"),
};

const PREFIX = "1/3/12/2026/09/20";

describe("media key hierarchy", () => {
  test("mediaDatePath zero-pads the UTC date of the recording start", () => {
    expect(mediaDatePath(SCOPE.startedAt)).toBe("2026/09/20");
    expect(mediaDatePath(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026/01/05");
    expect(mediaDatePath(new Date("2026-10-01T12:00:00.000Z"))).toBe("2026/10/01");
  });

  // a local-time reading would answer 09/21 whenever the host sits east of UTC
  test("the key date is UTC and never rolls at midnight", () => {
    const lateNight = new Date("2026-09-20T23:59:59.000Z");
    const nextDay = new Date("2026-09-21T00:00:01.000Z");
    expect(mediaDatePath(lateNight)).toBe("2026/09/20");
    expect(mediaDatePath(nextDay)).toBe("2026/09/21");
    expect(mediaDatePath(new Date("2025-12-31T23:59:59.000Z"))).toBe("2025/12/31");

    // one scope keeps one date for the whole capture, across the rollover
    const scope = { ...SCOPE, startedAt: lateNight };
    expect(masterSegmentLeaf(scope, 45, 0).key.startsWith("1/3/12/2026/09/20/")).toBe(true);
    expect(masterSegmentLeaf(scope, 45, 900).key.startsWith("1/3/12/2026/09/20/")).toBe(true);
  });

  test("master, clip, thumbnail, export, and result leaves follow the hierarchy", () => {
    expect(mediaPrefix(SCOPE, "master", 45)).toBe(`${PREFIX}/master/45`);
    expect(masterSegmentLeaf(SCOPE, 45, 0).key).toBe(`${PREFIX}/master/45/segments/0000000000.ts`);
    expect(masterSegmentLeaf(SCOPE, 45, 7).key).toBe(`${PREFIX}/master/45/segments/0000000007.ts`);
    expect(clipSegmentLeaf(SCOPE, 46, 3).key).toBe(`${PREFIX}/clips/46/segments/0000000003.ts`);
    expect(posterLeaf(SCOPE, 45).key).toBe(`${PREFIX}/master/45/poster.jpg`);
    expect(filmstripLeaf(SCOPE, 45, 1500).key).toBe(`${PREFIX}/master/45/timeline/000001500.jpg`);
    expect(exportLeaf(SCOPE, "master", 45, 9).key).toBe(
      `${PREFIX}/master/45/exports/export_9.mkv`,
    );
    expect(exportLeaf(SCOPE, "clips", 46, 9).key).toBe(`${PREFIX}/clips/46/exports/export_9.mkv`);
    expect(resultImageLeaves(SCOPE, 88, 12, "image/png")).toEqual({
      raw: { bucket: "travis-media", key: `${PREFIX}/results/88/img_12_raw.png` },
      annotated: { bucket: "travis-media", key: `${PREFIX}/results/88/img_12_annotated.png` },
    });
    expect(resultImageLeaves(SCOPE, 88, 12, "image/jpeg").raw.key).toBe(
      `${PREFIX}/results/88/img_12_raw.jpg`,
    );
  });

  test("filmstrip stills sort by time as strings", () => {
    expect(
      filmstripLeaf(SCOPE, 45, 1500).key < filmstripLeaf(SCOPE, 45, 120_000).key,
    ).toBe(true);
  });

  test("every leaf lands in the media bucket", () => {
    const leaves = [
      masterSegmentLeaf(SCOPE, 45, 0),
      clipSegmentLeaf(SCOPE, 46, 0),
      posterLeaf(SCOPE, 45),
      filmstripLeaf(SCOPE, 45, 0),
      exportLeaf(SCOPE, "master", 45, 1),
      resultImageLeaves(SCOPE, 88, 12, "image/png").raw,
      resultImageLeaves(SCOPE, 88, 12, "image/png").annotated,
    ];
    for (const leaf of leaves) expect(leaf.bucket).toBe("travis-media");
  });

  // no capture handle, ingest id, or uuid ever reaches a key
  test("every key is numeric scoped and carries no local identity", () => {
    const keys = [
      mediaPrefix(SCOPE, "master", 45),
      masterSegmentLeaf(SCOPE, 45, 0).key,
      clipSegmentLeaf(SCOPE, 46, 0).key,
      posterLeaf(SCOPE, 45).key,
      filmstripLeaf(SCOPE, 45, 0).key,
      exportLeaf(SCOPE, "clips", 46, 1).key,
      resultImageLeaves(SCOPE, 88, 12, "image/png").annotated.key,
    ];
    for (const key of keys) {
      expect(key).toMatch(/^\d+\/\d+\/\d+\/\d{4}\/\d{2}\/\d{2}\//);
      expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i); // uuid
      expect(key).not.toMatch(/capture|ingest|recordings\//i);
    }
  });
});

describe("resolveOrganizationId", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
    await testDb.execute(sql`DELETE FROM organization`);
  });

  test("a set organization id passes through", async () => {
    expect(await resolveOrganizationId(7, testDb)).toBe(7);
  });

  // project.organizationId is nullable until better-auth lands
  test("a null organization id falls back to the seeded default", async () => {
    const [org] = await testDb
      .insert(schema.organization)
      .values({ name: "default" })
      .returning({ organizationId: schema.organization.organizationId });
    expect(await resolveOrganizationId(null, testDb)).toBe(org!.organizationId);
  });

  test("a missing default organization is seeded, not invented", async () => {
    const id = await resolveOrganizationId(null, testDb);
    const rows = await testDb.select().from(schema.organization);
    expect(rows.map((row) => row.name)).toEqual(["default"]);
    expect(id).toBe(rows[0]!.organizationId);
  });
});
