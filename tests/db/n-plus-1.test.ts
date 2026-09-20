import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import { getItemResultSidebar, listProjectSummary } from "../../src/db/services/result.service";
import { listProjectStructureTree } from "../../src/db/services/structure.service";
import { getMasterVideoPlaybackData } from "../../src/db/services/video.service";
import * as schema from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import { createCountingDatabase, type QueryCounter } from "./support/counting-client";
import {
  ensureTestDatabase,
  truncateTestDatabase,
} from "../helpers/db";

// One shared counting db for seeding + measured reads. `counter.reset()` is called
// right before each measured call so only that call's statements are counted.
// Initialized in beforeAll: the connection may only open once travis_test exists.
let db: Db;
let counter: QueryCounter;
let closeCounting: () => Promise<void>;

const seedStructureTree = async (
  projectId: number,
  assets: number,
  componentsPerAsset: number,
  itemsPerComponent: number,
) => {
  await db
    .insert(schema.project)
    .values({ displayNumber: projectId, projectId, title: `Project ${projectId}` });

  let componentId = projectId * 10_000;
  let itemId = projectId * 1_000_000;

  for (let a = 1; a <= assets; a += 1) {
    const assetId = projectId * 1000 + a;
    await db
      .insert(schema.asset)
      .values({ assetId, projectId, name: `Asset ${a}` });

    for (let c = 1; c <= componentsPerAsset; c += 1) {
      componentId += 1;
      await db.insert(schema.component).values({
        componentId,
        assetId,
        projectId,
        name: `Component ${c}`,
      });

      for (let i = 1; i <= itemsPerComponent; i += 1) {
        itemId += 1;
        await db.insert(schema.item).values({
          itemId,
          componentId,
          projectId,
          assetId,
          itemLabel: `Item ${i}`,
        });
      }
    }
  }
};

const seedItemResultSidebar = async (
  sessions: number,
  resultsPerSession: number,
) => {
  const projectId = 1;

  await db.insert(schema.project).values({ displayNumber: projectId, projectId, title: "P" });
  await db.insert(schema.asset).values({ assetId: 1, projectId, name: "A" });
  await db
    .insert(schema.component)
    .values({ componentId: 1, assetId: 1, projectId, name: "C" });
  await db.insert(schema.item).values({
    itemId: 1,
    componentId: 1,
    projectId,
    assetId: 1,
    itemLabel: "I",
  });

  // Sessions are parents of both master_video and session_item → insert first.
  // The ordinal follows the loop: one project cannot repeat a display number.
  for (let s = 1; s <= sessions; s += 1) {
    await db
      .insert(schema.session)
      .values({ displayNumber: s, sessionId: s, projectId, name: `S${s}` });
  }

  await db.insert(schema.masterVideo).values({
    masterVideoId: 1,
    sessionId: 1,
    startEpoch: 1_000,
    endEpoch: 2_000,
  });

  let resultId = 100;
  let imageId = 100;
  let clipId = 100;

  for (let s = 1; s <= sessions; s += 1) {
    const sessionItemId = s * 10;
    await db
      .insert(schema.sessionItem)
      .values({ sessionItemId, sessionId: s, itemId: 1 });

    for (let r = 0; r < resultsPerSession; r += 1) {
      resultId += 1;
      await db.insert(schema.result).values({
        displayNumber: resultId,
        resultId,
        sessionItemId,
        inspectionTypeCode: "GVI",
        projectId,
        assetId: 1,
        componentId: 1,
        itemId: 1,
        sessionId: s,
      });

      imageId += 1;
      await db.insert(schema.resultImage).values({
        imageId,
        resultId,
        storageStem: `raw-${imageId}`,
      });

      clipId += 1;
      await db.insert(schema.videoClip).values({
        clipId,
        resultId,
        masterVideoId: 1,
        startOffsetMs: clipId * 10,
        endOffsetMs: clipId * 10 + 5,
      });
    }
  }
};

const seedMasterVideoPlayback = async (resultsWithClips: number) => {
  const projectId = 1;

  await db.insert(schema.project).values({ displayNumber: projectId, projectId, title: "P" });
  await db.insert(schema.session).values({ displayNumber: 2, sessionId: 1, projectId, name: "S" });
  await db.insert(schema.masterVideo).values({
    masterVideoId: 1,
    sessionId: 1,
    startEpoch: 1_000,
    endEpoch: 2_000,
  });
  await db.insert(schema.asset).values({ assetId: 1, projectId, name: "A" });
  await db
    .insert(schema.component)
    .values({ componentId: 1, assetId: 1, projectId, name: "C" });
  await db.insert(schema.item).values({
    itemId: 1,
    componentId: 1,
    projectId,
    assetId: 1,
    itemLabel: "I",
  });
  await db
    .insert(schema.sessionItem)
    .values({ sessionItemId: 1, sessionId: 1, itemId: 1 });

  for (let r = 1; r <= resultsWithClips; r += 1) {
    await db.insert(schema.result).values({
      displayNumber: r,
      resultId: r,
      sessionItemId: 1,
      inspectionTypeCode: "GVI",
      projectId,
      assetId: 1,
      componentId: 1,
      itemId: 1,
      sessionId: 1,
    });
    await db.insert(schema.videoClip).values({
      clipId: r,
      resultId: r,
      masterVideoId: 1,
      startOffsetMs: r * 100,
      endOffsetMs: r * 100 + 50,
    });
    await db.insert(schema.resultImage).values({
      imageId: r,
      resultId: r,
      storageStem: `raw-${r}`,
    });
  }
};

const seedProjectSummary = async (resultCount: number) => {
  const projectId = 1;

  await db.insert(schema.project).values({ displayNumber: projectId, projectId, title: "P" });
  await db.insert(schema.session).values({ displayNumber: 3, sessionId: 1, projectId, name: "S" });
  await db.insert(schema.masterVideo).values({
    masterVideoId: 1,
    sessionId: 1,
    startEpoch: 1_000,
    endEpoch: 2_000,
  });
  await db.insert(schema.asset).values({ assetId: 1, projectId, name: "A" });
  await db
    .insert(schema.component)
    .values({ componentId: 1, assetId: 1, projectId, name: "C" });
  await db.insert(schema.item).values({
    itemId: 1,
    componentId: 1,
    projectId,
    assetId: 1,
    itemLabel: "I",
  });
  await db
    .insert(schema.sessionItem)
    .values({ sessionItemId: 1, sessionId: 1, itemId: 1 });

  const codes = ["GVI", "CVI", "MGI", "CP", "FMD", "SCOUR"] as const;
  for (let i = 0; i < resultCount; i += 1) {
    const resultId = i + 1;
    const code = codes[i % codes.length]!;
    await db.insert(schema.result).values({
      displayNumber: resultId,
      resultId,
      sessionItemId: 1,
      inspectionTypeCode: code,
      projectId,
      assetId: 1,
      componentId: 1,
      itemId: 1,
      sessionId: 1,
    });

    if (code === "GVI") {
      await db.insert(schema.resultGvi).values({ resultId, condition: "ok" });
    } else if (code === "CVI") {
      await db.insert(schema.resultCvi).values({ resultId, memberType: "chord", cpPotentialMv: -850 });
    } else if (code === "CP") {
      await db.insert(schema.resultCp).values({ resultId, voltageMv: -850 });
    } else if (code === "FMD") {
      await db.insert(schema.resultFmd).values({
        resultId,
        initialAttempt: "dry",
        additionalAttempt1: "na",
        additionalAttempt2: "na",
        additionalAttempt3: "na",
      });
    }  else if (code === "SCOUR") {
      await db.insert(schema.resultScour).values({ resultId, exposedPile: "not_exposed" });
    } else {
      await db.insert(schema.resultMgi).values({
        resultId,
        noMgObserved: 0,
        criteriaPreset: "project_default",
      });
      await db.insert(schema.resultMgiFinding).values({
        resultMgiId: resultId,
        species: "Barnacles",
        sortOrder: 0,
      });
    }
  }
};

describe("N+1 query-count guard", () => {
  beforeAll(async () => {
    await ensureTestDatabase();
    const counting = await createCountingDatabase();
    db = counting.database;
    counter = counting.counter;
    closeCounting = counting.close;
  });

  afterAll(async () => {
    await closeCounting();
  });

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("listProjectStructureTree issues O(relations) queries, not O(rows)", async () => {
    // 5 assets × 5 components × 5 items = 125 leaf rows.
    await seedStructureTree(1, 5, 5, 5);

    counter.reset();
    const tree = await listProjectStructureTree(1, db);

    expect(tree).toHaveLength(5);
    // Batched = 3 queries (assets, components, items — each by denorm projectId).
    // The pre-fix N+1 version issued 1 + 5 + 25 = 31 queries.
    expect(counter.count).toBeLessThanOrEqual(6);
  });

  it("getItemResultSidebar issues O(relations) queries, not O(rows)", async () => {
    // 3 sessions × 4 results, each result with an image + a clip.
    await seedItemResultSidebar(3, 4);

    counter.reset();
    const sidebar = await getItemResultSidebar(1, db);

    expect(sidebar?.sessions).toHaveLength(3);
    // Batched = 6 queries (item, sessionItems, sessions, results, images, clips).
    // The pre-fix N+1 version issued 2 + 2*3 + 2*3*4 = 32 queries.
    expect(counter.count).toBeLessThanOrEqual(10);
  });

  it("getMasterVideoPlaybackData issues O(relations) queries, not O(rows)", async () => {
    // 8 distinct results, each with a clip + image.
    await seedMasterVideoPlayback(8);

    counter.reset();
    const data = await getMasterVideoPlaybackData(1, 1, db);

    expect(data?.events).toHaveLength(8);
    // Batched = 5 queries (master, session sources, event join, images, thumbnails).
    // The pre-fix version issued one image query per distinct resultId = 5 + 8 = 13.
    expect(counter.count).toBeLessThanOrEqual(8);
  });

  it("listProjectSummary issues O(types) queries, not O(rows)", async () => {
    // 20 results: 4 of each code, so all 5 typed-detail reads fire.
    await seedProjectSummary(20);

    counter.reset();
    const rows = await listProjectSummary(1, db);

    expect(rows).toHaveLength(20);
    // Batched = 6 queries (1 results + 5 typed-detail reads, one per code present).
    // The pre-fix N+1 version would be 1 + 20 = 21 queries.
    expect(counter.count).toBeLessThanOrEqual(8);
  });
});
