import type { DbOrTx } from "../../db/client";
import { getProjectById } from "../../db/services/project.service";
import { listResultImageSummariesByResultIds } from "../../db/services/result-media.service";
import { listProjectSummary } from "../../db/services/result.service";
import { listProjectTaskStructureTree } from "../../db/services/task-structure.service";
import { AppError } from "../../lib/error";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";

// One template row: exactly the variables the bundled docx template reads.
export type ReportResultRow = {
  task_group: string;
  task_code: string;
  description: string;
  type_code: string;
  part_code: string;
  inspection_type: string;
  result_value: string;
  remarks: string;
  created_at: string;
  // MinIO object key for the row's image; NO_IMAGE when the result has none
  image: string;
};

// The image module's resolve() breaks on falsy tag values under renderAsync
// (it returns a plain object where a promise is expected), so the row value
// must never be "". This sentinel resolves to the transparent placeholder.
// ponytail: switch back to "" when the module fixes its empty-value path.
export const NO_IMAGE = "none";

// The full variable set handed to docxtemplater.
export type ReportTemplateData = {
  project_title: string;
  project_id: number;
  document_id: string;
  generated_at: string;
  result_rows: ReportResultRow[];
};

// Task-tree labels carried onto every row for one target.
type TargetLabel = {
  task_group: string;
  task_code: string;
  description: string;
  type_code: string;
  part_code: string;
};

type SummaryRow = Awaited<ReturnType<typeof listProjectSummary>>[number];

const EMPTY_LABEL: TargetLabel = {
  task_group: "",
  task_code: "",
  description: "",
  type_code: "",
  part_code: "",
};

// Walk the tree once, collecting target labels plus their display order.
// flow: groups > codes > descriptions > types > part codes
const collectTargets = (groups: Awaited<ReturnType<typeof listProjectTaskStructureTree>>) => {
  const byDescriptionId = new Map<number, TargetLabel>();
  const byPartCodeId = new Map<number, TargetLabel>();
  const order: string[] = [];

  for (const group of groups) {
    for (const taskCode of group.taskCodes) {
      for (const descriptionNode of taskCode.descriptions) {
        byDescriptionId.set(descriptionNode.descriptionId, {
          task_group: group.code,
          task_code: taskCode.code,
          description: descriptionNode.label,
          type_code: "",
          part_code: "",
        });
        order.push(`description:${descriptionNode.descriptionId}`);

        for (const typeNode of descriptionNode.types) {
          for (const partCodeNode of typeNode.partCodes) {
            byPartCodeId.set(partCodeNode.partCodeId, {
              task_group: group.code,
              task_code: taskCode.code,
              // a part-code target keeps the plan's blank description column
              description: "",
              type_code: typeNode.code,
              part_code: partCodeNode.code,
            });
            order.push(`part_code:${partCodeNode.partCodeId}`);
          }
        }
      }
    }
  }

  return { byDescriptionId, byPartCodeId, order };
};

// Group results under the target id they hang off (description XOR part code).
const groupResultsByTarget = (summary: SummaryRow[]) => {
  const byTarget = new Map<string, SummaryRow[]>();

  for (const row of summary) {
    const key =
      row.descriptionId !== null ? `description:${row.descriptionId}` : `part_code:${row.partCodeId}`;
    const bucket = byTarget.get(key) ?? [];
    bucket.push(row);
    byTarget.set(key, bucket);
  }

  return byTarget;
};

// First image per result, resolved to its stored object key.
// Annotated twin wins when the column says it exists — same rule as the UI.
const collectImageKeys = async (resultIds: number[], database?: DbOrTx) => {
  const keys = new Map<number, string>();
  const imagesByResult = await listResultImageSummariesByResultIds(resultIds, database);

  for (const [resultId, images] of imagesByResult) {
    const first = images[0];
    if (!first) continue;
    const leaves = imageEvidenceLeaves(first.storageStem, first.imageId, first.contentType);
    keys.set(resultId, first.hasAnnotated ? leaves.annotated.key : leaves.raw.key);
  }

  return keys;
};

// Gather every variable the report template fills, in task-tree order.
// flow: project > tree > results > images > ordered rows
export const gatherReportData = async (
  projectId: number,
  database?: DbOrTx,
): Promise<ReportTemplateData> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new AppError(400, "invalid_project_id", "Project id must be a positive integer");
  }

  const projectRecord = await getProjectById(projectId, database);
  if (!projectRecord) {
    throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
  }

  const [groups, summary] = await Promise.all([
    listProjectTaskStructureTree(projectId, database),
    listProjectSummary(projectId, database),
  ]);

  const { byDescriptionId, byPartCodeId, order } = collectTargets(groups);
  const byTarget = groupResultsByTarget(summary);
  const imageKeys = await collectImageKeys(
    summary.map((row) => row.resultId),
    database,
  );

  // result_value is already formatted by listProjectSummary, so rows pass through
  const toRow = (row: SummaryRow, label: TargetLabel): ReportResultRow => ({
    ...label,
    inspection_type: row.inspectionTypeCode,
    result_value: row.resultValue,
    remarks: row.remarks ?? "",
    created_at: row.createdAt,
    image: imageKeys.get(row.resultId) ?? NO_IMAGE,
  });

  const rows: ReportResultRow[] = [];
  const visited = new Set<string>();

  // tree order first, so the report reads top-down like the workspace
  for (const key of order) {
    const bucket = byTarget.get(key);
    if (!bucket) continue;
    visited.add(key);
    const label = key.startsWith("description:")
      ? byDescriptionId.get(Number(key.slice("description:".length)))
      : byPartCodeId.get(Number(key.slice("part_code:".length)));
    for (const row of bucket) {
      rows.push(toRow(row, label ?? EMPTY_LABEL));
    }
  }

  // a result whose target left the tree still belongs in the report
  for (const [key, bucket] of byTarget) {
    if (visited.has(key)) continue;
    for (const row of bucket) {
      rows.push(toRow(row, EMPTY_LABEL));
    }
  }

  return {
    project_title: projectRecord.title,
    project_id: projectRecord.projectId,
    document_id: projectRecord.documentId ?? "",
    generated_at: new Date().toISOString(),
    result_rows: rows,
  };
};
