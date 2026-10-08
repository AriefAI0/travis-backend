// import-scale — times a large sheet through the real import route.
// Opt-in check, like the other drills here. Reads and writes the test database.
// Run: ~/.bun/bin/bun run tests/checks/import-scale.ts
import { appFor } from "../helpers/app";
import { ensureTestDatabase, testDb, truncateTestDatabase } from "../helpers/db";
import { importRoutes } from "../../src/features/import/routes";
import * as schema from "../../src/db/schema";

const app = appFor(testDb, importRoutes);

// A pathological sheet: five groups, but every row its own code, description,
// type, and part code. Nothing is reused, so this is the worst case for the
// resolver and the largest number of inserts an import can make.
const buildRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    taskGroup: `Group ${index % 5}`,
    taskCode: `TC-${String(Math.floor(index / 10)).padStart(5, "0")}`,
    description: `Item ${index}`,
    type: "GVI",
    partCode: `P-${index}`,
    preAssigned: index % 3 === 0 ? ["GVI"] : [],
  }));

const time = async (count: number) => {
  await truncateTestDatabase();
  await testDb
    .insert(schema.project)
    .values({ displayNumber: 1, projectId: 1, title: "Scale" });

  const rows = buildRows(count);
  const body = JSON.stringify({ projectId: 1, mode: "append", dryRun: false, rows });

  const startedAt = performance.now();
  const res = await app.request("/api/v1/import/task-structure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const elapsedMs = Math.round(performance.now() - startedAt);

  const payload = (await res.json()) as { ok: boolean; data: unknown };
  return { count, status: res.status, elapsedMs, summary: payload.data };
};

await ensureTestDatabase();

const dryRun = await time(5000);
console.log("dry run times the walk without writing:");
console.log(JSON.stringify(dryRun, null, 2));

const real = await time(5000);
console.log("\nreal run writes everything:");
console.log(JSON.stringify(real, null, 2));

// the pool would otherwise keep the process alive
process.exit(0);
