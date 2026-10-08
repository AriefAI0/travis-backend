import type {
  ImportRowInput,
  ImportTaskStructureInput,
  ImportTaskStructureSummary,
  TaskStructureTaskGroupNode,
} from "../../types/api";
import { AppError } from "../../lib/error";
import { inspectionType } from "../../types/api";
import { db, type DbOrTx } from "../client";
import {
  createPlannedInspectionRecord,
  listPlannedInspectionRecordsByProjectId,
} from "../repositories/planned-inspection.repository";
import {
  createDescription,
  createPartCode,
  createTaskCode,
  createTaskGroup,
  createType,
  deleteTaskStructureSelection,
  listProjectTaskStructureTree,
  previewTaskStructureDelete,
  type TaskStructureNodeRef,
} from "./task-structure.service";

/* ---------- the tree the import walks ---------- */

type ImportType = { typeId: number; partCodes: Map<string, number> };
type ImportDescription = { descriptionId: number; types: Map<string, ImportType> };
type ImportTaskCode = { taskCodeId: number; descriptions: Map<string, ImportDescription> };
type ImportGroup = { taskGroupId: number; taskCodes: Map<string, ImportTaskCode> };
type ImportTree = Map<string, ImportGroup>;

// The app's sameName rule, as a map key: trimmed and lower-cased. One lookup per
// level beats a scan of every sibling on every row.
const key = (value: string): string => value.trim().toLowerCase();

// A create service returns the inserted row. A null means the insert returned
// nothing, which is a real failure and never something to paper over.
const required = <T>(record: T | null, what: string): T => {
  if (record === null) throw new Error(`${what} was not created`);
  return record;
};

// The project tree as lookup maps, so a row resolves in five lookups and no search.
// flow: group > task code > description > type > part code
const seedTree = (groups: TaskStructureTaskGroupNode[]): ImportTree => {
  const tree: ImportTree = new Map();

  for (const group of groups) {
    const taskCodes = new Map<string, ImportTaskCode>();
    for (const taskCode of group.taskCodes) {
      const descriptions = new Map<string, ImportDescription>();
      for (const description of taskCode.descriptions) {
        const types = new Map<string, ImportType>();
        for (const type of description.types) {
          const partCodes = new Map<string, number>();
          for (const partCode of type.partCodes) {
            partCodes.set(key(partCode.code), partCode.partCodeId);
          }
          types.set(key(type.code), { typeId: type.typeId, partCodes });
        }
        descriptions.set(key(description.label), {
          descriptionId: description.descriptionId,
          types,
        });
      }
      taskCodes.set(key(taskCode.code), {
        taskCodeId: taskCode.taskCodeId,
        descriptions,
      });
    }
    tree.set(key(group.code), { taskGroupId: group.taskGroupId, taskCodes });
  }
  return tree;
};

// Where a row ends, and whether that endpoint can carry a planned inspection.
type ImportLeaf = {
  descriptionId: number | null;
  partCodeId: number | null;
  // the row named a type but no part code, so no target the API accepts
  stopsAtType: boolean;
};

// Find or create the chain for one row, top down. Every new node joins the tree,
// so the next row reuses it rather than writing a duplicate the constraints refuse.
// flow: group > task code > description? > type? > part code?
const resolveRow = async (
  tree: ImportTree,
  tx: DbOrTx,
  projectId: number,
  row: ImportRowInput,
): Promise<{ leaf: ImportLeaf; created: number }> => {
  let created = 0;

  const groupName = key(row.taskGroup);
  let group = tree.get(groupName);
  if (!group) {
    const record = required(
      await createTaskGroup({ projectId, code: row.taskGroup }, tx),
      "Task group",
    );
    group = { taskGroupId: record.taskGroupId, taskCodes: new Map() };
    tree.set(groupName, group);
    created += 1;
  }

  const taskCodeName = key(row.taskCode);
  let taskCode = group.taskCodes.get(taskCodeName);
  if (!taskCode) {
    const record = required(
      await createTaskCode({ taskGroupId: group.taskGroupId, code: row.taskCode }, tx),
      "Task code",
    );
    taskCode = { taskCodeId: record.taskCodeId, descriptions: new Map() };
    group.taskCodes.set(taskCodeName, taskCode);
    created += 1;
  }

  // a row with no description stops at the task code: the code stands alone
  if (row.description === null) {
    return { leaf: { descriptionId: null, partCodeId: null, stopsAtType: false }, created };
  }

  const descriptionName = key(row.description);
  let description = taskCode.descriptions.get(descriptionName);
  if (!description) {
    const record = required(
      await createDescription({ taskCodeId: taskCode.taskCodeId, label: row.description }, tx),
      "Description",
    );
    description = { descriptionId: record.descriptionId, types: new Map() };
    taskCode.descriptions.set(descriptionName, description);
    created += 1;
  }

  // no type: the description is the leaf
  if (row.type === null) {
    return {
      leaf: { descriptionId: description.descriptionId, partCodeId: null, stopsAtType: false },
      created,
    };
  }

  const typeName = key(row.type);
  let type = description.types.get(typeName);
  if (!type) {
    const record = required(
      await createType({ descriptionId: description.descriptionId, code: row.type }, tx),
      "Type",
    );
    type = { typeId: record.typeId, partCodes: new Map() };
    description.types.set(typeName, type);
    created += 1;
  }

  // a type with no part code holds no planned inspection
  if (row.partCode === null) {
    return {
      leaf: { descriptionId: description.descriptionId, partCodeId: null, stopsAtType: true },
      created,
    };
  }

  const partCodeName = key(row.partCode);
  let partCodeId = type.partCodes.get(partCodeName);
  if (partCodeId === undefined) {
    const record = required(
      await createPartCode({ typeId: type.typeId, code: row.partCode }, tx),
      "Part code",
    );
    partCodeId = record.partCodeId;
    type.partCodes.set(partCodeName, partCodeId);
    created += 1;
  }

  return {
    leaf: { descriptionId: description.descriptionId, partCodeId, stopsAtType: false },
    created,
  };
};

/* ---------- pre-assigned inspection types ---------- */

// The unique index covers (projectId, descriptionId, partCodeId, type). Postgres
// aborts a transaction on any failed statement, so a duplicate must be seen
// before the insert, never caught after it.
const plannedKey = (
  target: { descriptionId?: number; partCodeId?: number },
  code: string,
): string => `${target.descriptionId ?? ""}:${target.partCodeId ?? ""}:${code}`;

// Plan a row's pre-assigned codes on its deepest target. A code outside the
// seven, or a row that stops at a type, counts as a skip.
// flow: pick the target > validate the code > skip a planned pair > insert
const planInspections = async (
  tx: DbOrTx,
  projectId: number,
  planned: Set<string>,
  row: ImportRowInput,
  leaf: ImportLeaf,
): Promise<{ planned: number; alreadyPlanned: number; skipped: number }> => {
  const counts = { planned: 0, alreadyPlanned: 0, skipped: 0 };
  if (row.preAssigned.length === 0) return counts;

  const target =
    leaf.partCodeId !== null
      ? { partCodeId: leaf.partCodeId }
      : leaf.descriptionId !== null && !leaf.stopsAtType
        ? { descriptionId: leaf.descriptionId }
        : null;

  // no target the planned-inspection route accepts, so every code here is a skip
  if (target === null) {
    counts.skipped = row.preAssigned.length;
    return counts;
  }

  for (const raw of row.preAssigned) {
    const code = raw.trim().toUpperCase();
    const parsed = inspectionType.safeParse(code);
    if (!parsed.success) {
      counts.skipped += 1;
      continue;
    }

    const rowKey = plannedKey(target, parsed.data);
    if (planned.has(rowKey)) {
      counts.alreadyPlanned += 1;
      continue;
    }

    await createPlannedInspectionRecord(
      { projectId, inspectionTypeCode: parsed.data, ...target },
      tx,
    );
    planned.add(rowKey);
    counts.planned += 1;
  }
  return counts;
};

/* ---------- the import ---------- */

// Thrown at the end of a dry run so the transaction undoes every write.
const dryRunRollback = new Error("import dry run");

// Land a whole sheet in one transaction. Append keeps what exists and writes the
// rest; replace clears the project first. A dry run walks the same path and rolls
// back, so its counts always equal the real run's.
// flow: [replace guard] > seed the tree > per row resolve > plan inspections
export const importProjectTaskStructure = async (
  input: ImportTaskStructureInput,
  database?: DbOrTx,
): Promise<ImportTaskStructureSummary> => {
  const dryRun = input.dryRun ?? false;

  const summary: ImportTaskStructureSummary = {
    rows: { total: input.rows.length, imported: 0, matched: 0 },
    nodesCreated: 0,
    inspections: { planned: 0, alreadyPlanned: 0, skipped: 0 },
  };

  const run = async (tx: DbOrTx) => {
    if (input.mode === "replace") {
      const groups = await listProjectTaskStructureTree(input.projectId, tx);
      if (groups.length > 0) {
        const nodes: TaskStructureNodeRef[] = groups.map((group) => ({
          kind: "task_group",
          id: group.taskGroupId,
        }));
        if (dryRun) {
          // Read-only. The real delete also removes objects from storage after it
          // commits, and a rollback cannot bring those back, so a preview must
          // never call it.
          const preview = await previewTaskStructureDelete(nodes, tx);
          if (preview.blocked) {
            throw new AppError(
              409,
              "wrong_state",
              preview.reason ?? "selection is still live",
            );
          }
        } else {
          // refuses while an inspection runs, which rolls the whole import back
          await deleteTaskStructureSelection(nodes, tx);
        }
      }
    }

    const tree =
      input.mode === "replace"
        ? new Map<string, ImportGroup>()
        : seedTree(await listProjectTaskStructureTree(input.projectId, tx));

    // one read of what is already planned, so a duplicate is skipped, not caught
    const planned = new Set(
      (await listPlannedInspectionRecordsByProjectId(input.projectId, tx)).map((record) =>
        plannedKey(
          {
            descriptionId: record.descriptionId ?? undefined,
            partCodeId: record.partCodeId ?? undefined,
          },
          record.inspectionTypeCode,
        ),
      ),
    );

    for (const row of input.rows) {
      const { leaf, created } = await resolveRow(tree, tx, input.projectId, row);
      summary.nodesCreated += created;

      const counts = await planInspections(tx, input.projectId, planned, row, leaf);
      summary.inspections.planned += counts.planned;
      summary.inspections.alreadyPlanned += counts.alreadyPlanned;
      summary.inspections.skipped += counts.skipped;

      if (created === 0) summary.rows.matched += 1;
      else summary.rows.imported += 1;
    }

    if (dryRun) throw dryRunRollback;
  };

  try {
    if (dryRun) {
      // A dry run rolls back by throwing, so it always opens a transaction of its
      // own, even when the caller handed over a plain handle.
      await (database ?? db).transaction(run);
    } else {
      await (database ? run(database) : db.transaction(run));
    }
  } catch (error) {
    // the rollback itself is the dry run's success path
    if (!(dryRun && error === dryRunRollback)) throw error;
  }

  return summary;
};
