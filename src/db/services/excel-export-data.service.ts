// Everything one excel export needs: the column contract per inspection type,
// and the typed rows gathered for the ticked targets.
//
// The workbook writer reads this and nothing else, so every cell type is
// decided here. Numbers stay numbers and dates stay dates, because Excel sorts
// and filters on the typed value, not on its printed text.
// flow: ticked targets > results > ticked types > cap > details > typed cells

import type { DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import type { InspectionTypeCode } from "../../types/api";
import { listResultRecordsByTargetIds } from "../repositories/result.repository";
import { getProjectById } from "./project.service";
import { listSessionsByIds } from "./session.service";
import { listProjectTaskStructureTree } from "./task-structure.service";
import { listInspectionFormFieldRecordsByFormId } from "../repositories/inspection-form.repository";
import {
  ALIGN_LABEL,
  ATTEMPT_LABEL,
  BLOCKAGE_LABEL,
  COATING_CONDITION_LABEL,
  COATING_STATUS_LABEL,
  CONDITION_LABEL,
  GAP_LABEL,
  POSITION_LABEL,
  YES_NO_LABEL,
  collectTargets,
  type TargetLabel,
} from "./report-data.service";
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
} from "./result.service";
import { type DatasheetTargets, loadTargets } from "./datasheet-data.service";

// One export holds this many results across its ticked types. Detail reads run
// per result, so the cap keeps one job bounded.
export const MAX_EXCEL_RESULTS = 500;

// Where a preview stops reading details, per type.
export const PREVIEW_ROWS_PER_TYPE = 10;

export type ExcelCellType = "text" | "number" | "date";
export type ExcelCell = string | number | Date | null;

export type ExcelColumn = { key: string; label: string; type: ExcelCellType };

export type ExcelChildSet = {
  key: string;
  label: string;
  columns: ExcelColumn[];
};

export type ExcelTypeContract = {
  type: InspectionTypeCode;
  sheet: string;
  columns: ExcelColumn[];
  children: ExcelChildSet[];
};

const col = (key: string, label: string, type: ExcelCellType = "text"): ExcelColumn => ({
  key,
  label,
  type,
});
const num = (key: string, label: string) => col(key, label, "number");

// Identity columns lead every sheet, so a row stays readable out of context.
export const IDENTITY_COLUMNS: ExcelColumn[] = [
  num("result_id", "Result ID"),
  col("session", "Session"),
  col("task_group", "Task group"),
  col("task_code", "Task code"),
  col("description", "Description"),
  col("type_code", "Type"),
  col("part_code", "Part code"),
  col("class", "Class"),
  col("remarks", "Remarks"),
  col("recorded", "Recorded", "date"),
];

// All 13 types. RA is a gap mark, never a row.
export const EXCEL_CONTRACT: ExcelTypeContract[] = [
  {
    type: "GVI",
    sheet: "GVI",
    columns: [
      col("kp_range", "KP range"),
      num("depth_el", "Depth EL"),
      col("gvi_cp", "GVI CP"),
      num("gvi_ut", "GVI UT"),
      col("condition", "Condition"),
    ],
    children: [],
  },
  {
    type: "CVI",
    sheet: "CVI",
    columns: [col("datum_reference", "Datum ref")],
    children: [
      {
        key: "positions",
        label: "CVI positions",
        columns: [
          col("member_type", "Member type"),
          col("clock_position", "Clock"),
          num("ut_mm", "UT mm"),
          col("findings", "Findings"),
        ],
      },
      {
        key: "cp_findings",
        label: "CVI CP readings",
        columns: [num("cp_potential_mv", "CP mV"), col("remark", "Remark")],
      },
    ],
  },
  {
    type: "DVI",
    sheet: "DVI",
    columns: [
      col("datum_reference", "Datum ref"),
      col("member_type", "Member type"),
      num("cp_potential_mv", "CP mV"),
    ],
    children: [
      {
        key: "positions",
        label: "DVI positions",
        columns: [col("clock_position", "Clock"), num("ut_mm", "UT mm"), col("findings", "Findings")],
      },
    ],
  },
  {
    type: "MGI",
    sheet: "MGI",
    columns: [col("no_mg_observed", "MG observed"), col("criteria_preset", "Criteria")],
    children: [
      {
        key: "findings",
        label: "MGI findings",
        columns: [
          col("growth_type", "Growth type"),
          col("species", "Species"),
          num("coverage_percent", "Coverage %"),
          num("thickness_mm", "Thickness mm"),
          col("remarks", "Remarks"),
        ],
      },
    ],
  },
  {
    type: "CP",
    sheet: "CP",
    columns: [
      col("anode_type", "Anode type"),
      num("voltage_mv", "Voltage mV"),
      col("depletion", "Depletion"),
      num("anode_width", "W mm"),
      num("anode_height", "H mm"),
      num("anode_length", "L mm"),
      num("widest_pit", "Widest pit"),
      num("deepest_pit", "Deepest pit"),
    ],
    children: [],
  },
  {
    type: "FMD",
    sheet: "FMD",
    columns: [
      num("depth_el", "Depth EL"),
      col("initial_attempt", "Initial"),
      col("additional_attempt_1", "Add. 1"),
      col("additional_attempt_2", "Add. 2"),
      col("additional_attempt_3", "Add. 3"),
    ],
    children: [],
  },
  {
    type: "SCOUR",
    sheet: "SCOUR",
    columns: [
      col("location_leg1", "Location leg 1"),
      num("dim_a", "A"),
      num("dim_b", "B"),
      num("dim_c", "C"),
      col("exp_leg1", "Exp. leg 1"),
      num("height_exp_leg1", "Height exp. 1"),
      col("location_leg2", "Location leg 2"),
      col("exp_leg2", "Exp. leg 2"),
      num("height_exp_leg2", "Height exp. 2"),
    ],
    children: [],
  },
  {
    type: "BSI",
    sheet: "BSI",
    columns: [
      col("clamp_type", "Clamp type"),
      num("depth_el", "Depth EL"),
      num("clamp_bolt_nut_quantity", "Clamp bolts"),
      num("outboard_clamp_cp", "Outboard CP mV"),
      col("cp_anomaly_recommendation", "CP note"),
      col("hinge_pin", "Hinge pin"),
      num("hinge_bolt_nut_quantity", "Hinge bolts"),
      col("liners", "Liners"),
      col("inboard_gap_condition", "In. gap"),
      num("inboard_estimate_gap", "In. est."),
      col("inboard_alignment_condition", "In. align."),
      col("inboard_misaligned_position", "In. position"),
      col("inboard_anomaly_recommendation", "In. note"),
      col("outboard_gap_condition", "Out. gap"),
      num("outboard_estimate_gap", "Out. est."),
      col("outboard_alignment_condition", "Out. align."),
      col("outboard_misaligned_position", "Out. position"),
      col("outboard_anomaly_recommendation", "Out. note"),
      col("clamp_missing_bolts", "Clamp missing bolts"),
      col("clamp_missing_washers", "Clamp missing washers"),
      col("hinge_missing_bolts", "Hinge missing bolts"),
      col("hinge_missing_washers", "Hinge missing washers"),
    ],
    children: [],
  },
  {
    type: "CGB",
    sheet: "CGB",
    columns: [
      col("movement", "Movement"),
      col("movement_remark", "Movement remark"),
      col("debris", "Debris"),
      col("debris_type", "Debris type"),
    ],
    children: [],
  },
  {
    type: "RISER",
    sheet: "RISER",
    columns: [
      num("touchdown_distance", "TD from bend"),
      num("mudbrace_distance", "Bend to mudbrace"),
      num("bend_height", "Bend height"),
      col("coating_status", "Coating"),
      col("coating_condition", "Coating condition"),
      col("knee_brace", "Knee brace"),
      col("debris", "Debris"),
      col("debris_type", "Debris type"),
      col("anomaly", "Anomaly"),
      col("recommendation", "Recommendation"),
      col("restricted_access", "Restricted access"),
    ],
    children: [],
  },
  {
    type: "CAISSON",
    sheet: "CAISSON",
    columns: [
      col("visual_damage", "Visual damage"),
      col("visual_damage_note", "Visual damage note"),
      col("debris_present", "Debris"),
      col("debris_note", "Debris note"),
      col("grating_present", "Grating"),
      col("grating_blockage", "Grating blockage"),
      col("grating_note", "Grating note"),
      col("associated_pipes", "Associated pipes"),
      col("associated_pipes_note", "Pipes note"),
      col("cp_readings", "CP readings"),
    ],
    children: [],
  },
  {
    type: "SEABED",
    sheet: "SEABED",
    columns: [],
    children: [
      {
        key: "findings",
        label: "Seabed findings",
        columns: [
          num("range_meters", "Range m"),
          col("fixes", "Fixes"),
          col("debris", "Debris"),
          col("debris_type", "Debris type"),
        ],
      },
    ],
  },
  {
    type: "PIPELINE",
    sheet: "PIPELINE",
    columns: [
      col("location", "Location"),
      num("depth_el", "Depth EL"),
      col("orientation", "Orientation"),
    ],
    children: [
      {
        key: "findings",
        label: "Pipeline findings",
        columns: [
          col("pipeline_category", "Category"),
          col("pipeline_damage", "Damage type"),
          col("pipeline_debris", "Debris"),
          num("anode_cp_value", "Anode CP mV"),
          col("anode_depletion", "Anode depletion"),
          col("anode_kp", "Anode KP"),
          col("remarks", "Remarks"),
        ],
      },
    ],
  },
];

export const EXCEL_CONTRACT_BY_TYPE = new Map(EXCEL_CONTRACT.map((entry) => [entry.type, entry]));

export type ExcelRow = { resultId: number; cells: Record<string, ExcelCell> };
export type ExcelChildRow = { resultId: number; cells: Record<string, ExcelCell> };

export type ExcelSheet = {
  type: InspectionTypeCode;
  sheet: string;
  columns: ExcelColumn[];
  rows: ExcelRow[];
  children: { key: string; label: string; columns: ExcelColumn[]; rows: ExcelChildRow[] }[];
};

export type ExcelExportData = {
  projectTitle: string;
  documentId: string;
  sheets: ExcelSheet[];
};

/* ---------- cells ---------- */

// Text, or empty: a null never prints as "null".
const txt = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
// A number cell, or empty. Postgres numeric arrives as a string.
const number = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const label = (map: Record<string, string>, value: string | null) =>
  value ? (map[value] ?? value) : "";
const bool = (value: boolean | null) => (value === null ? "" : value ? "Yes" : "No");
const joined = (parts: string[]) => parts.filter(Boolean).join(", ");

const EMPTY_LABEL: TargetLabel = {
  task_group: "",
  task_code: "",
  description: "",
  type_code: "",
  part_code: "",
};

// Main cells and child sets for one result. Every type in the contract answers.
// flow: detail read > typed cells > child rows
const shapeResult = async (
  resultId: number,
  type: InspectionTypeCode,
  database?: DbOrTx,
): Promise<{ cells: Record<string, ExcelCell>; children: Record<string, Record<string, ExcelCell>[]> }> => {
  const empty = { cells: {}, children: {} };

  switch (type) {
    case "GVI": {
      const detail = await getGviDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          kp_range: txt(detail.kpRange),
          depth_el: number(detail.depthEl),
          gvi_cp: joined(detail.cpFindings.map((finding) => txt(finding.value))),
          gvi_ut: number(detail.gviUt),
          condition: label(CONDITION_LABEL, detail.condition),
        },
        children: {},
      };
    }
    case "CP": {
      const detail = await getCpDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          anode_type: txt(detail.anodeType),
          voltage_mv: number(detail.voltageMv),
          depletion: txt(detail.depletion),
          anode_width: number(detail.anodeWidth),
          anode_height: number(detail.anodeHeight),
          anode_length: number(detail.anodeLength),
          widest_pit: number(detail.widestPit),
          deepest_pit: number(detail.deepestPit),
        },
        children: {},
      };
    }
    case "FMD": {
      const detail = await getFmdDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          depth_el: number(detail.depthEl),
          initial_attempt: label(ATTEMPT_LABEL, detail.initialAttempt),
          additional_attempt_1: label(ATTEMPT_LABEL, detail.additionalAttempt1),
          additional_attempt_2: label(ATTEMPT_LABEL, detail.additionalAttempt2),
          additional_attempt_3: label(ATTEMPT_LABEL, detail.additionalAttempt3),
        },
        children: {},
      };
    }
    case "SCOUR": {
      const detail = await getScourDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          location_leg1: txt(detail.locationLeg1),
          dim_a: number(detail.dimA),
          dim_b: number(detail.dimB),
          dim_c: number(detail.dimC),
          exp_leg1: label(YES_NO_LABEL, detail.expLeg1),
          height_exp_leg1: number(detail.heightExpLeg1),
          location_leg2: txt(detail.locationLeg2),
          exp_leg2: label(YES_NO_LABEL, detail.expLeg2),
          height_exp_leg2: number(detail.heightExpLeg2),
        },
        children: {},
      };
    }
    case "CVI": {
      const detail = await getCviDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: { datum_reference: txt(detail.datumReference) },
        children: {
          positions: detail.members.flatMap((member) =>
            member.positions.map((position) => ({
              member_type: member.memberType.toUpperCase(),
              clock_position: position.clockPosition,
              ut_mm: number(position.utMm),
              findings: txt(position.findings),
            })),
          ),
          cp_findings: detail.cpFindings.map((finding) => ({
            cp_potential_mv: number(finding.value),
            remark: txt(finding.remark),
          })),
        },
      };
    }
    case "DVI": {
      const detail = await getDviDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          datum_reference: txt(detail.datumReference),
          member_type: detail.memberType.toUpperCase(),
          cp_potential_mv: number(detail.cpPotentialMv),
        },
        children: {
          positions: detail.positions.map((position) => ({
            clock_position: position.clockPosition,
            ut_mm: number(position.utMm),
            findings: txt(position.findings),
          })),
        },
      };
    }
    case "MGI": {
      const detail = await getResultMgiDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          no_mg_observed: detail.detail.noMgObserved ? "Yes" : "No",
          criteria_preset: txt(detail.detail.criteriaPreset),
        },
        children: {
          findings: detail.findings.map((finding) => ({
            growth_type: txt(finding.growthType),
            species: txt(finding.species),
            coverage_percent: number(finding.coveragePercent),
            thickness_mm: number(finding.thicknessMm),
            remarks: txt(finding.remarks),
          })),
        },
      };
    }
    case "BSI": {
      const detail = await getBsiDetailByResultId(resultId, database);
      if (!detail) return empty;
      const positions = (parts: { position: string }[]) => joined(parts.map((part) => part.position));
      return {
        cells: {
          clamp_type: txt(detail.clampType),
          depth_el: number(detail.depthEl),
          clamp_bolt_nut_quantity: number(detail.clampBoltNutQuantity),
          outboard_clamp_cp: number(detail.outboardClampCP),
          cp_anomaly_recommendation: txt(detail.cpAnomalyRecommendation),
          hinge_pin: bool(detail.hingePin),
          hinge_bolt_nut_quantity: number(detail.hingeBoltNutQuantity),
          liners: bool(detail.liners),
          inboard_gap_condition: label(GAP_LABEL, detail.inboardGapCondition),
          inboard_estimate_gap: number(detail.inboardEstimateGap),
          inboard_alignment_condition: label(ALIGN_LABEL, detail.inboardAlignmentCondition),
          inboard_misaligned_position: label(POSITION_LABEL, detail.inboardMisalignedPosition),
          inboard_anomaly_recommendation: txt(detail.inboardAnomalyRecommendation),
          outboard_gap_condition: label(GAP_LABEL, detail.outboardGapCondition),
          outboard_estimate_gap: number(detail.outboardEstimateGap),
          outboard_alignment_condition: label(ALIGN_LABEL, detail.outboardAlignmentCondition),
          outboard_misaligned_position: label(POSITION_LABEL, detail.outboardMisalignedPosition),
          outboard_anomaly_recommendation: txt(detail.outboardAnomalyRecommendation),
          clamp_missing_bolts: positions(detail.clampMissingBolts),
          clamp_missing_washers: positions(detail.clampMissingWashers),
          hinge_missing_bolts: positions(detail.hingeMissingBolts),
          hinge_missing_washers: positions(detail.hingeMissingWashers),
        },
        children: {},
      };
    }
    case "CGB": {
      const detail = await getCgbDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          movement: label(YES_NO_LABEL, detail.movement),
          movement_remark: txt(detail.remark),
          debris: label(YES_NO_LABEL, detail.debris),
          debris_type: txt(detail.debrisType),
        },
        children: {},
      };
    }
    case "RISER": {
      const detail = await getRiserDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          touchdown_distance: number(detail.touchdownDistanceFromRiserBend),
          mudbrace_distance: number(detail.riserBendDistanceToMudbraceMember),
          bend_height: number(detail.riserBendHeightToSeabed),
          coating_status: label(COATING_STATUS_LABEL, detail.coatingStatus),
          coating_condition: label(COATING_CONDITION_LABEL, detail.coatingCondition),
          knee_brace: label(YES_NO_LABEL, detail.kneeBrace),
          debris: label(YES_NO_LABEL, detail.debris),
          debris_type: txt(detail.debrisType),
          anomaly: label(YES_NO_LABEL, detail.anomaly),
          recommendation: txt(detail.recommendation),
          restricted_access: label(YES_NO_LABEL, detail.restrictedAccess),
        },
        children: {},
      };
    }
    case "CAISSON": {
      const detail = await getCiDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          visual_damage: bool(detail.visualDamage),
          visual_damage_note: txt(detail.visualDamageRecommendation),
          debris_present: bool(detail.debrisPresent),
          debris_note: txt(detail.debrisRecommendation),
          grating_present: bool(detail.gratingPresent),
          grating_blockage: label(BLOCKAGE_LABEL, detail.gratingBlockage),
          grating_note: txt(detail.gratingAnomalyRecommendation),
          associated_pipes: joined(detail.gviAssociatedPipes.map((pipe) => pipe.position)),
          associated_pipes_note: txt(detail.associatedPipesRecommendation),
          cp_readings: joined(detail.cpFindings.map((finding) => txt(finding.cpMv))),
        },
        children: {},
      };
    }
    case "SEABED": {
      const detail = await getSeabedDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {},
        children: {
          findings: detail.findings.map((finding) => ({
            range_meters: number(finding.rangeMeters),
            fixes: txt(finding.fixes),
            debris: label(YES_NO_LABEL, finding.debris),
            debris_type: txt(finding.debrisType),
          })),
        },
      };
    }
    case "PIPELINE": {
      const detail = await getPipelineDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          location: txt(detail.location),
          depth_el: number(detail.depthEl),
          orientation: txt(detail.orientation),
        },
        children: {
          findings: detail.findings.map((finding) => ({
            pipeline_category: txt(finding.category),
            pipeline_damage: txt(finding.damageType),
            pipeline_debris: txt(finding.debrisType),
            anode_cp_value: number(finding.anodeCpValue),
            anode_depletion: txt(finding.anodeDepletion),
            anode_kp: txt(finding.anodeKp),
            remarks: txt(finding.remarks),
          })),
        },
      };
    }
    default:
      return empty;
  }
};

// Custom field labels per form version, so a raw field id becomes its heading.
const customLabelsFor = async (formIds: number[], database?: DbOrTx) =>
  new Map(
    await Promise.all(
      formIds.map(async (formId) => {
        const fields = await listInspectionFormFieldRecordsByFormId(formId, database);
        return [
          formId,
          new Map(fields.filter((field) => !field.isBuiltin).map((field) => [String(field.inspectionFormFieldId), field.label])),
        ] as const;
      }),
    ),
  );

// A custom field id becomes a sheet column keyed by its label slug.
const customKey = (labelText: string) => `custom_${labelText.replace(/\W+/g, "_")}`;

// The form's unique label index keeps headings apart. Legacy rows merged from
// two form versions can still repeat one, so the second copy gets a suffix.
const headingFor = (labelText: string, columns: ExcelColumn[]) => {
  if (!columns.some((column) => column.label === labelText)) return labelText;
  let suffix = 2;
  while (columns.some((column) => column.label === `${labelText} (${suffix})`)) suffix++;
  return `${labelText} (${suffix})`;
};

// Custom cells for one result, plus any column this result introduces.
const customCellsFor = (
  values: unknown,
  labels: Map<string, string> | undefined,
  columns: ExcelColumn[],
): Record<string, ExcelCell> => {
  if (!values || !labels) return {};
  const cells: Record<string, ExcelCell> = {};

  for (const [fieldId, value] of Object.entries(values as Record<string, unknown>)) {
    const labelText = labels.get(fieldId);
    if (!labelText) continue;
    const key = customKey(labelText);
    if (!columns.some((column) => column.key === key)) {
      columns.push({
        key,
        label: headingFor(labelText, columns),
        type: typeof value === "number" ? "number" : "text",
      });
    }
    cells[key] = typeof value === "number" ? value : txt(value);
  }

  return cells;
};

/* ---------- entry point ---------- */

// Gather every ticked type's rows, in task-tree order. A foreign target id has
// no rows here: loadTargets keeps only this project's results.
// flow: tree + results > ticked types > cap > sessions > details > sheets
export const gatherExcelExport = async (
  projectId: number,
  types: InspectionTypeCode[],
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
  maxRowsPerType = Number.POSITIVE_INFINITY,
): Promise<ExcelExportData> => {
  const started = performance.now();
  const { project, sorted, byDescriptionId, byPartCodeId } = await loadTargets(
    projectId,
    targets,
    organizationId,
    database,
  );

  const ticked = sorted.filter((record) => types.includes(record.inspectionTypeCode));
  if (ticked.length > MAX_EXCEL_RESULTS) {
    throw new AppError(
      413,
      "too_many_results",
      `${ticked.length} results selected; one export holds at most ${MAX_EXCEL_RESULTS}`,
    );
  }

  const sessionIds = [...new Set(ticked.map((record) => record.sessionId))].filter(
    (id): id is number => id !== null,
  );
  const sessions = sessionIds.length ? await listSessionsByIds(sessionIds, database) : [];
  const sessionNames = new Map(sessions.map((session) => [session.sessionId, session.name]));

  const formIds = [...new Set(ticked.map((record) => record.inspectionFormId))].filter(
    (id): id is number => id !== null,
  );
  const customLabels = await customLabelsFor(formIds, database);

  const sheets: ExcelSheet[] = [];

  for (const contract of EXCEL_CONTRACT) {
    if (!types.includes(contract.type)) continue;
    const picked = ticked.filter((record) => record.inspectionTypeCode === contract.type);

    const rows: ExcelRow[] = [];
    const childRows = new Map<string, ExcelChildRow[]>(
      contract.children.map((child) => [child.key, []]),
    );
    // a type-wide list: one column per custom label, whatever result brought it
    const customColumns: ExcelColumn[] = [];

    for (const record of picked) {
      if (rows.length >= maxRowsPerType) break;

      const label: TargetLabel =
        (record.descriptionId !== null
          ? byDescriptionId.get(record.descriptionId)
          : record.partCodeId !== null
            ? byPartCodeId.get(record.partCodeId)
            : undefined) ?? EMPTY_LABEL;

      const shaped = await shapeResult(record.resultId, contract.type, database);

      // custom values ride after the typed cells, one column per label
      const labels =
        record.inspectionFormId === null ? undefined : customLabels.get(record.inspectionFormId);

      rows.push({
        resultId: record.resultId,
        cells: {
          result_id: record.resultId,
          session: record.sessionId === null ? "" : (sessionNames.get(record.sessionId) ?? ""),
          task_group: label.task_group,
          task_code: label.task_code,
          description: label.description,
          type_code: label.type_code,
          part_code: label.part_code,
          class: record.resultClass,
          remarks: txt(record.remarks),
          recorded: record.createdAt,
          ...shaped.cells,
          ...customCellsFor(record.customValues, labels, customColumns),
        },
      });

      for (const [key, childSet] of childRows) {
        for (const child of shaped.children[key] ?? []) {
          childSet.push({ resultId: record.resultId, cells: child });
        }
      }
    }

    sheets.push({
      type: contract.type,
      sheet: contract.sheet,
      columns: [...IDENTITY_COLUMNS, ...contract.columns, ...customColumns],
      rows,
      children: contract.children.map((child) => ({
        key: child.key,
        label: child.label,
        columns: child.columns,
        rows: childRows.get(child.key) ?? [],
      })),
    });
  }

  if (ticked.length >= MAX_EXCEL_RESULTS) {
    log.info("excel export gather", { projectId, results: ticked.length, ms: Math.round(performance.now() - started) });
  }

  return {
    projectTitle: project.title,
    documentId: project.documentId ?? "",
    sheets,
  };
};

// The dialog preview: same sheets, ten rows per type.
export const previewExcelExport = (
  projectId: number,
  types: InspectionTypeCode[],
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
) =>
  gatherExcelExport(projectId, types, targets, organizationId, database, PREVIEW_ROWS_PER_TYPE);
