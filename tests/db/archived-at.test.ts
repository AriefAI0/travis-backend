import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";

import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../helpers/db";
import { findAssetById, listAssetRecords } from "../../src/db/repositories/asset.repository";
import {
  findComponentById,
  listComponentRecords,
} from "../../src/db/repositories/component.repository";
import { findItemById, listItemRecords } from "../../src/db/repositories/item.repository";
import {
  findProjectById,
  listProjectRecords,
} from "../../src/db/repositories/project.repository";
import { findResultById, listResultRecords } from "../../src/db/repositories/result.repository";
import { findSessionById, listSessionRecords } from "../../src/db/repositories/session.repository";
import * as schema from "../../src/db/schema";

// Nothing writes archived_at in the app today (Track F is future-proofing for an
// archive feature). These tests verify the filter directly by setting the column.
describe("archived_at filtering", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  beforeEach(async () => {
    await truncateTestDatabase();
  });

  it("hides archived rows from list reads but keeps them findable by id", async () => {
    await testDb.insert(schema.project).values({ displayNumber: 1, projectId: 1, title: "P" });
    await testDb.insert(schema.session).values({ displayNumber: 1, sessionId: 1, projectId: 1, name: "S" });
    await testDb.insert(schema.asset).values({ assetId: 1, projectId: 1, name: "A" });
    await testDb
      .insert(schema.component)
      .values({ componentId: 1, assetId: 1, projectId: 1, name: "C" });
    await testDb.insert(schema.item).values({
      itemId: 1,
      componentId: 1,
      projectId: 1,
      assetId: 1,
      itemLabel: "I",
    });
    await testDb
      .insert(schema.sessionItem)
      .values({ sessionItemId: 1, sessionId: 1, itemId: 1 });
    await testDb.insert(schema.result).values({
      displayNumber: 1,
      resultId: 1,
      sessionItemId: 1,
      inspectionTypeCode: "GVI",
      projectId: 1,
      assetId: 1,
      componentId: 1,
      itemId: 1,
      sessionId: 1,
    });

    // Sanity: every list read sees its row before archiving.
    expect(await listProjectRecords(testDb)).toHaveLength(1);
    expect(await listSessionRecords(testDb)).toHaveLength(1);
    expect(await listAssetRecords(testDb)).toHaveLength(1);
    expect(await listComponentRecords(testDb)).toHaveLength(1);
    expect(await listItemRecords(testDb)).toHaveLength(1);
    expect(await listResultRecords(testDb)).toHaveLength(1);

    const archivedAt = new Date();
    await testDb
      .update(schema.project)
      .set({ archivedAt })
      .where(eq(schema.project.projectId, 1));
    await testDb
      .update(schema.session)
      .set({ archivedAt })
      .where(eq(schema.session.sessionId, 1));
    await testDb
      .update(schema.asset)
      .set({ archivedAt })
      .where(eq(schema.asset.assetId, 1));
    await testDb
      .update(schema.component)
      .set({ archivedAt })
      .where(eq(schema.component.componentId, 1));
    await testDb.update(schema.item).set({ archivedAt }).where(eq(schema.item.itemId, 1));
    await testDb
      .update(schema.result)
      .set({ archivedAt })
      .where(eq(schema.result.resultId, 1));

    // Collection reads now exclude the archived rows ...
    expect(await listProjectRecords(testDb)).toHaveLength(0);
    expect(await listSessionRecords(testDb)).toHaveLength(0);
    expect(await listAssetRecords(testDb)).toHaveLength(0);
    expect(await listComponentRecords(testDb)).toHaveLength(0);
    expect(await listItemRecords(testDb)).toHaveLength(0);
    expect(await listResultRecords(testDb)).toHaveLength(0);

    // ... while by-id lookups still return them (operational lookups are
    // intentionally unfiltered — an archived entity may still be referenced).
    expect(await findProjectById(1, testDb)).not.toBeNull();
    expect(await findSessionById(1, testDb)).not.toBeNull();
    expect(await findAssetById(1, testDb)).not.toBeNull();
    expect(await findComponentById(1, testDb)).not.toBeNull();
    expect(await findItemById(1, testDb)).not.toBeNull();
    expect(await findResultById(1, testDb)).not.toBeNull();
  });
});
