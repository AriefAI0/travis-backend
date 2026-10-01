// Load seed for the workspace grids: one project holding thousands of part codes.
// flow: remove old seed > project > tree in chunks > one session > a few results
import { desc, eq } from "drizzle-orm";
import { intro, log, outro } from "@clack/prompts";

import { db } from "../src/db/client";
import * as schema from "../src/db/schema";

const SEED_TITLE = "Load test 5000";
const TASK_CODES = 10;
const DESCRIPTIONS_PER_TASK_CODE = 5;
const TYPES_PER_DESCRIPTION = 2;
// part codes per type, so the tree holds exactly this many leaves
const DEFAULT_PART_CODES = 5000;
// one statement per chunk keeps the insert plan small
const INSERT_CHUNK = 500;
// every Nth part code carries a result, so the grids show real counts
const RESULT_EVERY = 20;
const INSPECTION_TYPES = ["GVI", "CVI"] as const;

// split rows into statement-sized chunks
function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// next free project display number (the index is unique across the org-less set)
async function nextProjectDisplayNumber(): Promise<number> {
  const rows = await db
    .select({ displayNumber: schema.project.displayNumber })
    .from(schema.project)
    .orderBy(desc(schema.project.displayNumber))
    .limit(1);

  return (rows[0]?.displayNumber ?? 0) + 1;
}

// drop the previous seed run; the project cascade takes its whole tree
async function removeOldSeed(): Promise<number | null> {
  const existing = await db
    .select({ projectId: schema.project.projectId })
    .from(schema.project)
    .where(eq(schema.project.title, SEED_TITLE));

  const old = existing[0];
  if (!old) return null;

  await db.delete(schema.project).where(eq(schema.project.projectId, old.projectId));
  return old.projectId;
}

// flow: seed project > task group > task codes
async function createProjectTree(partCodesPerType: number, partCodeCount: number) {
  const projectRows = await db
    .insert(schema.project)
    .values({
      displayNumber: await nextProjectDisplayNumber(),
      title: SEED_TITLE,
      description: `Load seed: ${partCodeCount} part codes.`,
    })
    .returning({ projectId: schema.project.projectId });
  const projectId = projectRows[0]!.projectId;

  const groupRows = await db
    .insert(schema.taskGroup)
    .values({ projectId, code: "900", label: "Load group" })
    .returning({ taskGroupId: schema.taskGroup.taskGroupId });
  const taskGroupId = groupRows[0]!.taskGroupId;

  const taskCodeRows = await db
    .insert(schema.taskCode)
    .values(
      Array.from({ length: TASK_CODES }, (_, index) => ({
        taskGroupId,
        code: `9${String(index + 1).padStart(2, "0")}`,
        label: `Load row ${index + 1}`,
        displayOrder: index,
      })),
    )
    .returning({ taskCodeId: schema.taskCode.taskCodeId });

  const descriptionRows = await db
    .insert(schema.description)
    .values(
      taskCodeRows.flatMap((taskCodeRow, taskCodeIndex) =>
        Array.from({ length: DESCRIPTIONS_PER_TASK_CODE }, (_, index) => ({
          taskCodeId: taskCodeRow.taskCodeId,
          label: `D${taskCodeIndex + 1}-${index + 1}`,
          displayOrder: index,
        })),
      ),
    )
    .returning({ descriptionId: schema.description.descriptionId });

  const typeRows = await db
    .insert(schema.type)
    .values(
      descriptionRows.flatMap((descriptionRow, descriptionIndex) =>
        Array.from({ length: TYPES_PER_DESCRIPTION }, (_, index) => ({
          descriptionId: descriptionRow.descriptionId,
          code: `T${descriptionIndex + 1}.${index + 1}`,
          label: `Type ${descriptionIndex + 1}.${index + 1}`,
          displayOrder: index,
        })),
      ),
    )
    .returning({ typeId: schema.type.typeId });

  // flow: per type > 5000 leaves total > chunked insert > returning ids
  const partCodeIds: number[] = [];
  for (const typeRow of typeRows) {
    const values = Array.from({ length: partCodesPerType }, (_, index) => ({
      typeId: typeRow.typeId,
      code: `PC-${typeRow.typeId}-${String(index + 1).padStart(4, "0")}`,
      label: `Part ${index + 1}`,
      displayOrder: index,
    }));

    for (const chunk of chunks(values, INSERT_CHUNK)) {
      const inserted = await db
        .insert(schema.partCode)
        .values(chunk)
        .returning({ partCodeId: schema.partCode.partCodeId });
      partCodeIds.push(...inserted.map((row) => row.partCodeId));
    }
  }

  return { projectId, taskGroupId, typeCount: typeRows.length, partCodeIds };
}

// a handful of results, so the grids show badges and non-zero counts
async function createResults(projectId: number, partCodeIds: number[]): Promise<number> {
  const sessionRows = await db
    .insert(schema.session)
    .values({ projectId, displayNumber: 1, name: "Load run 1" })
    .returning({ sessionId: schema.session.sessionId });
  const sessionId = sessionRows[0]!.sessionId;

  const targets = partCodeIds.filter((_, index) => index % RESULT_EVERY === 0);
  const values = targets.map((partCodeId, index) => ({
    inspectionTypeCode: INSPECTION_TYPES[index % INSPECTION_TYPES.length]!,
    projectId,
    sessionId,
    partCodeId,
    layer: (index % 2) + 1,
    masterStartMs: index * 1000,
    displayNumber: index + 1,
  }));

  for (const chunk of chunks(values, INSERT_CHUNK)) {
    await db.insert(schema.result).values(chunk);
  }

  return values.length;
}

// flow: arg > part codes per type > seed > report
async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? DEFAULT_PART_CODES);
  const divisor = TASK_CODES * DESCRIPTIONS_PER_TASK_CODE * TYPES_PER_DESCRIPTION;

  if (!Number.isInteger(requested) || requested <= 0 || requested % divisor !== 0) {
    log.error(
      `Count must be a multiple of ${divisor}. Example: bun run scripts/seed-large-project.ts ${DEFAULT_PART_CODES}`,
    );
    process.exit(1);
  }

  intro(`seeding ${requested} part codes`);
  if (requested !== DEFAULT_PART_CODES) {
    log.warn(`Seeding ${requested} part codes into a project named "${SEED_TITLE}".`);
  }

  const removed = await removeOldSeed();
  if (removed !== null) log.step(`removed the previous seed project ${removed}`);

  const tree = await createProjectTree(requested / divisor, requested);
  const resultCount = await createResults(tree.projectId, tree.partCodeIds);

  log.info(
    `project ${tree.projectId}: ${TASK_CODES} task codes, ${tree.typeCount} types, ${tree.partCodeIds.length} part codes, ${resultCount} results`,
  );
  outro(`open project ${tree.projectId} in the app`);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
