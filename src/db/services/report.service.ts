import type { DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import { getProjectById } from "./project.service";
import { listResultImageSummariesByResultIds } from "./result-media.service";
import {
  getBsiDetailByResultId,
  getCpDetailByResultId,
  getCviDetailByResultId,
  getDviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getResultMgiDetailByResultId,
  getScourDetailByResultId,
  listProjectSummary,
} from "./result.service";
import { listProjectTaskStructureTree } from "./task-structure.service";

/* ---------- template contract ---------- */

// One row of a type table. Keys match the template tags per type.
export type ReportRow = Record<string, string>;

// The image module breaks on a falsy tag value under renderAsync, so a section
// without a picture carries this sentinel instead of "".
// ponytail: back to "" once the module handles empty values.
export const NO_IMAGE = "none";

// Flags the template reads. Exactly one is true, or none for a type with no
// result table yet (CAISSON, RA) — that section then renders nothing.
type SectionFlags = {
  isGVI: boolean;
  isCVI: boolean;
  isDVI: boolean;
  isMGI: boolean;
  isCP: boolean;
  isFMD: boolean;
  isSCOUR: boolean;
  isBSI: boolean;
};

export type ReportSection = SectionFlags & {
  inspection_type: string;
  image: string;
  rows: ReportRow[];
};

// One task-tree target with one section per inspection type on it.
export type ReportItem = {
  task_group: string;
  task_code: string;
  description: string;
  type_code: string;
  part_code: string;
  sections: ReportSection[];
};

// The full variable set handed to docxtemplater.
export type ReportTemplateData = {
  project_title: string;
  project_id: number;
  document_id: string;
  generated_at: string;
  items: ReportItem[];
};

const KNOWN_TYPES = ["GVI", "CVI", "DVI", "MGI", "CP", "FMD", "SCOUR", "BSI"] as const;

// Flags for one section: every known type false, the section's own type true.
const flagsFor = (type: string): SectionFlags =>
  Object.fromEntries(KNOWN_TYPES.map((t) => [`is${t}`, t === type])) as SectionFlags;

// Sections read in template order, so the report does not depend on the
// result rows arriving in any particular order. Unlisted types sort last.
const TYPE_RANK = new Map<string, number>(KNOWN_TYPES.map((type, index) => [type, index]));
const byTypeRank = (a: ReportSection, b: ReportSection) =>
  (TYPE_RANK.get(a.inspection_type) ?? KNOWN_TYPES.length) -
  (TYPE_RANK.get(b.inspection_type) ?? KNOWN_TYPES.length);

/* ---------- value formatting ---------- */

// Enum wording mirrors the app so the report reads like the workspace.
const CONDITION_LABEL: Record<string, string> = {
  ok: "Good Condition",
  not_ok: "Visual Damage",
};
const ATTEMPT_LABEL: Record<string, string> = { dry: "Dry", flooded: "Flooded", na: "N/A" };
const PILE_LABEL: Record<string, string> = { exposed: "Exposed", not_exposed: "Not Exposed" };
const GAP_LABEL: Record<string, string> = { gap: "Gap", no_gap: "No Gap" };
const ALIGN_LABEL: Record<string, string> = { aligned: "Aligned", misaligned: "Misaligned" };
const POSITION_LABEL: Record<string, string> = { top: "Top", mid: "Mid", bottom: "Bottom" };

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
const yesNo = (value: boolean | null) => (value === null ? "" : value ? "Yes" : "No");
const label = (map: Record<string, string>, value: string | null) =>
  value ? (map[value] ?? value) : "";
// missing-part lists flatten to one cell: clock positions, comma separated
const positions = (parts: { position: string }[]) => parts.map((part) => part.position).join(", ");

/* ---------- per-type rows ---------- */

type SummaryRow = Awaited<ReturnType<typeof listProjectSummary>>[number];

// Rows for one result, shaped for its type's table. CVI/DVI and MGI repeat the
// parent fields down each child row: a table row cannot hold its own loop.
// ponytail: one readback per result, so 2-5 queries each. Batch by type when a
// project grows past a few hundred results.
const rowsForResult = async (row: SummaryRow, database?: DbOrTx): Promise<ReportRow[]> => {
  const remarks = row.remarks ?? "";
  const recorded = row.createdAt;

  switch (row.inspectionTypeCode) {
    case "GVI": {
      const detail = await getGviDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          kp_range: text(detail.kpRange),
          depth_el: text(detail.depthEl),
          gvi_cp: text(detail.gviCP),
          gvi_ut: text(detail.gviUT),
          condition: label(CONDITION_LABEL, detail.condition),
          remarks,
          recorded,
        },
      ];
    }
    case "CP": {
      const detail = await getCpDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          anode_type: text(detail.anodeType),
          voltage_mv: text(detail.voltageMv),
          depletion: text(detail.depletion),
          anode_width: text(detail.anodeWidth),
          anode_height: text(detail.anodeHeight),
          anode_length: text(detail.anodeLength),
          widest_pit: text(detail.widestPit),
          deepest_pit: text(detail.deepestPit),
          remarks,
          recorded,
        },
      ];
    }
    case "FMD": {
      const detail = await getFmdDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          depth_el: text(detail.depthEl),
          initial_attempt: label(ATTEMPT_LABEL, detail.initialAttempt),
          additional_attempt_1: label(ATTEMPT_LABEL, detail.additionalAttempt1),
          additional_attempt_2: label(ATTEMPT_LABEL, detail.additionalAttempt2),
          additional_attempt_3: label(ATTEMPT_LABEL, detail.additionalAttempt3),
          remarks,
          recorded,
        },
      ];
    }
    case "SCOUR": {
      const detail = await getScourDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          exposed_pile: label(PILE_LABEL, detail.exposedPile),
          exposed_pile_height: text(detail.exposedPileHeight),
          height_leg1: text(detail.heightLeg1),
          height_midpoint: text(detail.heightMidpoint),
          height_leg2: text(detail.heightLeg2),
          remarks,
          recorded,
        },
      ];
    }
    case "CVI":
    case "DVI": {
      const detail =
        row.inspectionTypeCode === "CVI"
          ? await getCviDetailByResultId(row.resultId, database)
          : await getDviDetailByResultId(row.resultId, database);
      if (!detail) return [];
      const head = {
        datum_reference: text(detail.datumReference),
        member_type: detail.memberType.toUpperCase(),
        cp_potential_mv: text(detail.cpPotentialMv),
      };
      const found = detail.positions.map((position) => ({
        ...head,
        clock_position: position.clockPosition,
        ut_mm: text(position.utMm),
        findings: text(position.findings),
      }));
      // a result with no positions still gets its header row
      return found.length ? found : [{ ...head, clock_position: "", ut_mm: "", findings: "" }];
    }
    case "MGI": {
      const detail = await getResultMgiDetailByResultId(row.resultId, database);
      if (!detail) return [];
      const head = {
        no_mg_observed: detail.detail.noMgObserved ? "Yes" : "No",
        criteria_preset: text(detail.detail.criteriaPreset),
      };
      const found = detail.findings.map((finding) => ({
        ...head,
        growth_type: text(finding.growthType),
        species: text(finding.species),
        coverage_percent: text(finding.coveragePercent),
        thickness_mm: text(finding.thicknessMm),
        remarks: text(finding.remarks),
      }));
      return found.length
        ? found
        : [{ ...head, growth_type: "", species: "", coverage_percent: "", thickness_mm: "", remarks: "" }];
    }
    case "BSI": {
      const detail = await getBsiDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          clamp_type: text(detail.clampType),
          depth_el: text(detail.depthEl),
          clamp_bolt_nut_quantity: text(detail.clampBoltNutQuantity),
          outboard_clamp_cp: text(detail.outboardClampCP),
          cp_anomaly_recommendation: text(detail.cpAnomalyRecommendation),
          hinge_pin: yesNo(detail.hingePin),
          hinge_bolt_nut_quantity: text(detail.hingeBoltNutQuantity),
          liners: yesNo(detail.liners),
          inboard_gap_condition: label(GAP_LABEL, detail.inboardGapCondition),
          inboard_estimate_gap: text(detail.inboardEstimateGap),
          inboard_alignment_condition: label(ALIGN_LABEL, detail.inboardAlignmentCondition),
          inboard_misaligned_position: label(POSITION_LABEL, detail.inboardMisalignedPosition),
          inboard_anomaly_recommendation: text(detail.inboardAnomalyRecommendation),
          outboard_gap_condition: label(GAP_LABEL, detail.outboardGapCondition),
          outboard_estimate_gap: text(detail.outboardEstimateGap),
          outboard_alignment_condition: label(ALIGN_LABEL, detail.outboardAlignmentCondition),
          outboard_misaligned_position: label(POSITION_LABEL, detail.outboardMisalignedPosition),
          outboard_anomaly_recommendation: text(detail.outboardAnomalyRecommendation),
          clamp_missing_bolts: positions(detail.clampMissingBolts),
          clamp_missing_washers: positions(detail.clampMissingWashers),
          hinge_missing_bolts: positions(detail.hingeMissingBolts),
          hinge_missing_washers: positions(detail.hingeMissingWashers),
          remarks,
          recorded,
        },
      ];
    }
    // a type with no result table yet renders an empty section
    default:
      return [];
  }
};

/* ---------- task tree ---------- */

// Task-tree labels carried onto every item.
type TargetLabel = {
  task_group: string;
  task_code: string;
  description: string;
  type_code: string;
  part_code: string;
};

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
// An annotated twin wins when the column says it exists — same rule as the UI.
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

// Fold one target's results into a section per inspection type, keeping the
// order the types first appear.
const buildSections = (
  results: SummaryRow[],
  rowsByResult: Map<number, ReportRow[]>,
  imageKeys: Map<number, string>,
): ReportSection[] => {
  const buckets = new Map<string, SummaryRow[]>();

  for (const row of results) {
    const bucket = buckets.get(row.inspectionTypeCode) ?? [];
    bucket.push(row);
    buckets.set(row.inspectionTypeCode, bucket);
  }

  return [...buckets]
    .map(([type, bucket]) => ({
      inspection_type: type,
      // the section's picture is its first result that has one
      image: bucket.map((row) => imageKeys.get(row.resultId)).find(Boolean) ?? NO_IMAGE,
      ...flagsFor(type),
      rows: bucket.flatMap((row) => rowsByResult.get(row.resultId) ?? []),
    }))
    .sort(byTypeRank);
};

/* ---------- entry point ---------- */

// Gather every variable the report template fills, in task-tree order.
// flow: project > tree + summary > typed rows > images > grouped items
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

  // one detail readback per result, all in flight at once
  const [rowsByResult, imageKeys] = await Promise.all([
    Promise.all(
      summary.map(async (row) => [row.resultId, await rowsForResult(row, database)] as const),
    ).then((entries) => new Map(entries)),
    collectImageKeys(
      summary.map((row) => row.resultId),
      database,
    ),
  ]);

  const items: ReportItem[] = [];
  const visited = new Set<string>();

  const pushItem = (key: string, target: TargetLabel) => {
    const bucket = byTarget.get(key);
    if (!bucket) return;
    items.push({ ...target, sections: buildSections(bucket, rowsByResult, imageKeys) });
  };

  // tree order first, so the report reads top-down like the workspace
  for (const key of order) {
    if (!byTarget.has(key)) continue;
    visited.add(key);
    const target = key.startsWith("description:")
      ? byDescriptionId.get(Number(key.slice("description:".length)))
      : byPartCodeId.get(Number(key.slice("part_code:".length)));
    pushItem(key, target ?? EMPTY_LABEL);
  }

  // a result whose target left the tree still belongs in the report
  for (const key of byTarget.keys()) {
    if (visited.has(key)) continue;
    pushItem(key, EMPTY_LABEL);
  }

  return {
    project_title: projectRecord.title,
    project_id: projectRecord.projectId,
    document_id: projectRecord.documentId ?? "",
    generated_at: new Date().toISOString(),
    items,
  };
};
