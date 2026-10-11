import type { DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import { imageEvidenceLeaves } from "../../lib/minio_storage/paths";
import type { ReportScope } from "../../types/api";
import { getProjectById } from "./project.service";
import { listResultImageSummariesByResultIds } from "./result-media.service";
import {
  getBsiDetailByResultId,
  getCgbDetailByResultId,
  getCiDetailByResultId,
  getCpDetailByResultId,
  getCviDetailByResultId,
  getDviDetailByResultId,
  getFmdDetailByResultId,
  getGviDetailByResultId,
  getPipelineDetailByResultId,
  getResultMgiDetailByResultId,
  getRiserDetailByResultId,
  getScourDetailByResultId,
  getSeabedDetailByResultId,
  listProjectSummary,
} from "./result.service";
import { listProjectTaskStructureTree } from "./task-structure.service";

/* ---------- template contract ---------- */

// One row of a type table. Keys match the template tags per type.
export type ReportRow = Record<string, string>;

// Flags the template reads. Exactly one is true, or none for a type with no
// result table yet (RA) — that section then renders nothing.
type SectionFlags = {
  isGVI: boolean;
  isCVI: boolean;
  isDVI: boolean;
  isMGI: boolean;
  isCP: boolean;
  isFMD: boolean;
  isSCOUR: boolean;
  isBSI: boolean;
  isCGB: boolean;
  isRISER: boolean;
  isCAISSON: boolean;
  isSEABED: boolean;
  isPIPELINE: boolean;
};

export type ReportSection = SectionFlags & {
  inspection_type: string;
  // The target the section hangs off: `description:100` or `part_code:300`.
  // Stable across renders, so a refresh finds the same regions every time.
  // The renderer turns this plus the type into region tags.
  target_key: string;
  // Object keys for the section's picture, best first: the result's own
  // evidence image, then the clip still taken while it was inspected. The
  // renderer keeps the first that loads, and draws no frame when none does.
  image_keys: string[];
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

// One line of the title page's contents list: the target, and the inspection
// types recorded against it.
export type ReportIndexRow = { index_label: string; index_types: string };

// The full variable set handed to docxtemplater.
export type ReportTemplateData = {
  project_title: string;
  project_id: number;
  document_id: string;
  generated_at: string;
  // The title-page counts, taken after the scope filter, so a scope-limited
  // report states its own size.
  total_targets: number;
  total_results: number;
  // The contents list. `has_index` guards the table: an empty row loop would
  // leave a table with no rows, which Word reads as a damaged file.
  has_index: boolean;
  index: ReportIndexRow[];
  // Zone switches. Each zone is data, not a fixed layout, so a zone turned off
  // leaves nothing behind and a zone never supplied cannot drop silently.
  content: boolean;
  closing: boolean;
  items: ReportItem[];
};

const KNOWN_TYPES = [
  "GVI",
  "CVI",
  "DVI",
  "MGI",
  "CP",
  "FMD",
  "SCOUR",
  "BSI",
  "CGB",
  "RISER",
  "CAISSON",
  "SEABED",
  "PIPELINE",
] as const;

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
const YES_NO_LABEL: Record<string, string> = { yes: "Yes", no: "No" };
const COATING_STATUS_LABEL: Record<string, string> = { present: "Present", "not-present": "Not present" };
const COATING_CONDITION_LABEL: Record<string, string> = { good: "Good", "peel-off": "Peel-off" };
const BLOCKAGE_LABEL: Record<string, string> = {
  "0_25": "0-25%",
  "25_50": "25-50%",
  "50_75": "50-75%",
  "75_100": "75-100%",
};

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
          gvi_cp: detail.cpFindings
            .map((finding) => text(finding.value))
            .filter(Boolean)
            .join(", "),
          gvi_ut: text(detail.gviUt),
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
    case "CVI": {
      const detail = await getCviDetailByResultId(row.resultId, database);
      if (!detail) return [];
      const head = { datum_reference: text(detail.datumReference) };
      // schema-update model: member_type lives per position, CP readings are findings
      const positionRows = detail.members.flatMap((member) =>
        member.positions.map((position) => ({
          ...head,
          member_type: member.memberType.toUpperCase(),
          cp_potential_mv: "",
          clock_position: position.clockPosition,
          ut_mm: text(position.utMm),
          findings: text(position.findings),
        })),
      );
      const cpRows = detail.cpFindings.map((finding) => ({
        ...head,
        member_type: "",
        cp_potential_mv: text(finding.value),
        clock_position: "",
        ut_mm: "",
        findings: text(finding.remark),
      }));
      // a result with neither positions nor CP findings still gets its header row
      return positionRows.length + cpRows.length
        ? [...positionRows, ...cpRows]
        : [{ ...head, member_type: "", cp_potential_mv: "", clock_position: "", ut_mm: "", findings: "" }];
    }
    case "DVI": {
      const detail = await getDviDetailByResultId(row.resultId, database);
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
    case "CGB": {
      const detail = await getCgbDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          movement: label(YES_NO_LABEL, detail.movement),
          movement_remark: text(detail.remark),
          debris: label(YES_NO_LABEL, detail.debris),
          debris_type: text(detail.debrisType),
          remarks,
          recorded,
        },
      ];
    }
    case "RISER": {
      const detail = await getRiserDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          touchdown_distance: text(detail.touchdownDistanceFromRiserBend),
          mudbrace_distance: text(detail.riserBendDistanceToMudbraceMember),
          bend_height: text(detail.riserBendHeightToSeabed),
          coating_status: label(COATING_STATUS_LABEL, detail.coatingStatus),
          coating_condition: label(COATING_CONDITION_LABEL, detail.coatingCondition),
          knee_brace: label(YES_NO_LABEL, detail.kneeBrace),
          debris: label(YES_NO_LABEL, detail.debris),
          debris_type: text(detail.debrisType),
          anomaly: label(YES_NO_LABEL, detail.anomaly),
          recommendation: text(detail.recommendation),
          restricted_access: label(YES_NO_LABEL, detail.restrictedAccess),
          remarks,
          recorded,
        },
      ];
    }
    case "CAISSON": {
      const detail = await getCiDetailByResultId(row.resultId, database);
      if (!detail) return [];
      return [
        {
          visual_damage: yesNo(detail.visualDamage),
          visual_damage_note: text(detail.visualDamageRecommendation),
          debris_present: yesNo(detail.debrisPresent),
          debris_note: text(detail.debrisRecommendation),
          grating_present: yesNo(detail.gratingPresent),
          grating_blockage: label(BLOCKAGE_LABEL, detail.gratingBlockage),
          grating_note: text(detail.gratingAnomalyRecommendation),
          // the two child lists flatten into one cell each
          associated_pipes: detail.gviAssociatedPipes
            .map((pipe) => pipe.position)
            .join(", "),
          associated_pipes_note: text(detail.associatedPipesRecommendation),
          cp_readings: detail.cpFindings
            .map((finding) => text(finding.cpMv))
            .filter(Boolean)
            .join(", "),
          remarks,
          recorded,
        },
      ];
    }
    case "SEABED": {
      const detail = await getSeabedDetailByResultId(row.resultId, database);
      if (!detail) return [];
      const found = detail.findings.map((finding) => ({
        range_meters: text(finding.rangeMeters),
        fixes: text(finding.fixes),
        debris: label(YES_NO_LABEL, finding.debris),
        debris_type: text(finding.debrisType),
        remarks,
        recorded,
      }));
      // a survey with no lines still gets its header row
      return found.length
        ? found
        : [{ range_meters: "", fixes: "", debris: "", debris_type: "", remarks, recorded }];
    }
    case "PIPELINE": {
      const detail = await getPipelineDetailByResultId(row.resultId, database);
      if (!detail) return [];
      const head = {
        location: text(detail.location),
        depth_el: text(detail.depthEl),
        orientation: text(detail.orientation),
      };
      // parent fields repeat down each finding row, as CVI/DVI and MGI do;
      // the row is a finding, so its own remarks win over the result's
      const found = detail.findings.map((finding) => ({
        ...head,
        pipeline_category: text(finding.category),
        pipeline_damage: text(finding.damageType),
        pipeline_debris: text(finding.debrisType),
        remarks: text(finding.remarks),
        recorded,
      }));
      return found.length
        ? found
        : [
            {
              ...head,
              pipeline_category: "",
              pipeline_damage: "",
              pipeline_debris: "",
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

// Picture candidates per result, best first: the evidence image is the one the
// inspector annotated, so an annotated twin wins over the raw shot — same rule
// as the UI. Nothing else stands in for it, so a result with no evidence image
// renders an empty frame.
// flow: evidence leaves > candidates per result
const collectImageKeys = async (resultIds: number[], database?: DbOrTx) => {
  const imagesByResult = await listResultImageSummariesByResultIds(resultIds, database);

  const keys = new Map<number, string[]>();
  for (const resultId of resultIds) {
    const first = imagesByResult.get(resultId)?.[0];
    if (!first) continue;

    const leaves = imageEvidenceLeaves(first.storageStem, first.imageId, first.contentType);
    keys.set(resultId, [first.hasAnnotated ? leaves.annotated.key : leaves.raw.key]);
  }

  return keys;
};

// Fold one target's results into a section per inspection type, keeping the
// order the types first appear. One target holds one section per type, so the
// target key plus the type names a region exactly once.
const buildSections = (
  results: SummaryRow[],
  rowsByResult: Map<number, ReportRow[]>,
  imageKeys: Map<number, string[]>,
  targetKey: string,
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
      target_key: targetKey,
      // the section's picture comes from its first result that has one
      image_keys: bucket.map((row) => imageKeys.get(row.resultId)).find(Boolean) ?? [],
      ...flagsFor(type),
      rows: bucket.flatMap((row) => rowsByResult.get(row.resultId) ?? []),
    }))
    .sort(byTypeRank);
};

/* ---------- entry point ---------- */

// Gather every variable the report template fills, in task-tree order.
// `scope` picks which results the report covers: `all` keeps every real result,
// `anomaly` keeps only anomaly-class ones. Neither scope carries an RA mark —
// a restricted-access mark is evidence of a gap, not an inspection result.
// flow: project > tree + summary > scope filter > typed rows > images > items
export const gatherReportData = async (
  projectId: number,
  scope: ReportScope = "all",
  database?: DbOrTx,
): Promise<ReportTemplateData> => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new AppError(400, "invalid_project_id", "Project id must be a positive integer");
  }

  const projectRecord = await getProjectById(projectId, database);
  if (!projectRecord) {
    throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
  }

  const [groups, allResults] = await Promise.all([
    listProjectTaskStructureTree(projectId, database),
    listProjectSummary(projectId, database),
  ]);

  const summary = allResults.filter(
    (row) => !row.isRa && (scope === "all" || row.resultClass === "anomaly"),
  );

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
    items.push({ ...target, sections: buildSections(bucket, rowsByResult, imageKeys, key) });
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

  // A target label: the description, or the part code when the target has none.
  const index: ReportIndexRow[] = items.map((item) => ({
    index_label: item.description || item.part_code,
    index_types: item.sections.map((section) => section.inspection_type).join(", "),
  }));

  return {
    project_title: projectRecord.title,
    project_id: projectRecord.projectId,
    document_id: projectRecord.documentId ?? "",
    generated_at: new Date().toISOString(),
    total_targets: items.length,
    total_results: summary.length,
    has_index: index.length > 0,
    index,
    content: true,
    closing: true,
    items,
  };
};
