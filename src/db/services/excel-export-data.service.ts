// Everything one excel export needs: the column contract per inspection type,
// and the typed rows gathered for the ticked targets.
//
// One row is one reading. A result with three findings ships three rows, and
// the identity cells repeat on each. A result with none ships one row.
// The workbook writer reads this and nothing else, so every cell type is
// decided here. Numbers stay numbers and dates stay dates, because Excel sorts
// and filters on the typed value, not on its printed text.
// flow: ticked targets > results > ticked types > cap > details > flat rows

import type { DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import type { GviCPFindingDetail, InspectionTypeCode } from "../../types/api";
import { listResultRecordsByTargetIds } from "../repositories/result.repository";
import { getProjectById } from "./project.service";
import { listSessionsByIds } from "./session.service";
import { listProjectTaskStructureTree } from "./task-structure.service";
import { listInspectionFormFieldRecordsByFormId } from "../repositories/inspection-form.repository";
import {
  ALIGN_LABEL,
  ATTEMPT_LABEL,
  BLOCKAGE_LABEL,
  CONDITION_LABEL,
  GAP_LABEL,
  YES_NO_LABEL,
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

// Where a preview stops adding sheet rows, per type.
export const PREVIEW_ROWS_PER_TYPE = 10;

export type ExcelCellType = "text" | "number" | "date";
export type ExcelCell = string | number | Date | null;

export type ExcelColumn = { key: string; label: string; type: ExcelCellType };

export type ExcelTypeContract = {
  type: InspectionTypeCode;
  sheet: string;
  columns: ExcelColumn[];
};

const col = (key: string, label: string, type: ExcelCellType = "text"): ExcelColumn => ({
  key,
  label,
  type,
});
const num = (key: string, label: string) => col(key, label, "number");

// Identity columns lead every sheet, so a row stays readable out of context.
// Timestamp is the row's own time in UTC: the reading's, else the result's.
export const IDENTITY_COLUMNS: ExcelColumn[] = [
  num("result_id", "Result ID"),
  col("session", "Session"),
  col("task_code", "Task code"),
  col("description", "Description"),
  col("part_code", "Part code"),
  col("class", "Class"),
  col("recorded", "Timestamp (UTC)", "date"),
];

// All 13 types. RA is a gap mark, never a row.
export const EXCEL_CONTRACT: ExcelTypeContract[] = [
  {
    type: "GVI",
    sheet: "GVI",
    columns: [
      num("depth_el", "Depth EL (-)"),
      num("gvi_contact", "Contact - CP Reading (mV)"),
      num("gvi_proximity", "Proximity - CP Reading (mV)"),
      col("gvi_cp_remark", "CP Remarks"),
      num("mgi_depth", "MGI Depth"),
      num("mgi_soft", "MGI Soft Coverage"),
      num("mgi_hard", "MGI Hard Coverage"),
      col("mgi_remarks", "MGI Remarks"),
      col("condition", "Condition"),
    ],
  },
  {
    type: "CVI",
    sheet: "CVI",
    columns: [
      col("datum_reference", "Datum Reference"),
      col("member_type", "Member"),
      col("clock_position", "Clock position"),
      num("ut_mm", "UT Value (mm)"),
      col("findings", "Remarks"),
      num("cp_potential_mv", "CP Value (mV)"),
      col("cp_remark", "CP Remarks"),
    ],
  },
  {
    type: "DVI",
    sheet: "DVI",
    columns: [
      col("datum_reference", "Datum Reference"),
      col("member_type", "Member Type"),
      col("clock_position", "Clock position"),
      num("ut_mm", "UT Value (mm)"),
      col("findings", "Findings"),
      num("cp_potential_mv", "CP Potential (mV)"),
    ],
  },
  {
    type: "MGI",
    sheet: "MGI",
    columns: [
      col("no_mg_observed", "No MG observed"),
      col("criteria_preset", "Criteria preset"),
      col("growth_type", "Growth"),
      col("species", "Species"),
      col("species_other_text", "Other species detail"),
      num("coverage_percent", "Coverage %"),
      num("thickness_mm", "Thickness mm"),
      col("remarks", "Finding remarks"),
    ],
  },
  {
    type: "CP",
    sheet: "CP",
    columns: [
      col("anode_type", "Anode Type"),
      num("voltage_mv", "CP potential (mV)"),
      col("depletion", "Depletion (%)"),
      num("anode_width", "Width"),
      num("anode_height", "Height"),
      num("anode_length", "Length"),
      num("widest_pit", "Widest"),
      num("deepest_pit", "Deepest"),
    ],
  },
  {
    type: "FMD",
    sheet: "FMD",
    columns: [
      num("depth_el", "Depth EL (-)"),
      col("initial_attempt", "Initial Attempt"),
      col("additional_attempt_1", "Additional Attempt 1"),
      col("additional_attempt_2", "Additional Attempt 2"),
      col("additional_attempt_3", "Additional Attempt 3"),
    ],
  },
  {
    type: "SCOUR",
    sheet: "SCOUR",
    columns: [
      col("location_leg1", "Leg 1"),
      col("location_leg2", "Leg 2"),
      num("dim_a", "DIM A"),
      num("dim_b", "DIM B"),
      num("dim_c", "DIM C"),
      col("exp_leg1", "Leg 1 pile exposed"),
      col("exp_leg2", "Leg 2 pile exposed"),
      num("height_exp_leg1", "Leg 1 exposed height"),
      num("height_exp_leg2", "Leg 2 exposed height"),
    ],
  },
  {
    type: "BSI",
    sheet: "BSI",
    columns: [
      col("clamp_type", "Clamp Type"),
      num("depth_el", "Depth EL (-)"),
      num("clamp_bolt_nut_quantity", "Clamp Bolts & Nuts Quantity"),
      col("clamp_missing_bolts", "Clamp Missing Bolts"),
      col("clamp_missing_washers", "Clamp Missing Washer"),
      num("outboard_clamp_cp", "Outboard Clamp CP"),
      col("cp_anomaly_recommendation", "CP Anomaly Recommendation"),
      col("hinge_pin", "Hinge Pin"),
      num("hinge_bolt_nut_quantity", "Hinge Bolts & Nuts Quantity"),
      col("hinge_missing_bolts", "Hinge Missing Bolts"),
      col("hinge_missing_washers", "Hinge Missing Washer"),
      col("liners", "Liners"),
      col("inboard_gap_condition", "In-board Gap Condition"),
      num("inboard_estimate_gap", "In-board Estimate Gap"),
      col("inboard_alignment_condition", "In-board Alignment Condition"),
      col("inboard_misaligned_position", "In-board Misaligned Position"),
      col("inboard_anomaly_recommendation", "In-board Anomaly Recommendation"),
      col("outboard_gap_condition", "Out-board Gap Condition"),
      num("outboard_estimate_gap", "Out-board Estimate Gap"),
      col("outboard_alignment_condition", "Out-board Alignment Condition"),
      col("outboard_misaligned_position", "Out-board Misaligned Position"),
      col("outboard_anomaly_recommendation", "Out-board Anomaly Recommendation"),
    ],
  },
  {
    type: "CGB",
    sheet: "CGB",
    columns: [
      col("movement", "Movement"),
      col("movement_remark", "Movement Remark"),
      col("debris", "Debris"),
      col("debris_type", "Debris Type"),
    ],
  },
  {
    type: "RISER",
    sheet: "RISER",
    columns: [
      num("touchdown_distance", "Touchdown - Distance from Riser Bend"),
      num("mudbrace_distance", "Riser Bend - Distance to Mudbrace Member"),
      num("bend_height", "Riser Bend - Height to Seabed"),
      col("coating_status", "Coating"),
      col("coating_condition", "Coating Condition"),
      col("knee_brace", "Knee Brace"),
      col("debris", "Debris"),
      col("debris_type", "Debris Type"),
      col("anomaly", "Anomaly"),
      col("recommendation", "Recommendation"),
      col("restricted_access", "Restricted Access"),
    ],
  },
  {
    type: "CAISSON",
    sheet: "CAISSON",
    columns: [
      col("visual_damage", "Caisson Body GVI"),
      col("visual_damage_recommendation", "Damage Recommendation"),
      col("debris_present", "Debris Present"),
      col("debris_recommendation", "Debris Recommendation"),
      col("grating_present", "Grating Present"),
      col("grating_blockage", "Grating Blockage"),
      col("grating_anomaly_recommendation", "Grating Recommendation"),
      num("cp_mv", "CP Value (mV)"),
      col("cp_remark", "CP Remarks"),
      col("associated_pipes", "Associated pipes"),
      col("associated_pipes_recommendation", "Associated pipes note"),
    ],
  },
  {
    type: "SEABED",
    sheet: "SEABED",
    columns: [
      num("range_meters", "Range (m)"),
      col("fixes", "Fixes"),
      col("debris", "Debris"),
      col("debris_type", "Debris Type"),
    ],
  },
  {
    type: "PIPELINE",
    sheet: "PIPELINE",
    columns: [
      col("location", "Location"),
      num("depth_el", "Depth EL"),
      col("orientation", "Orientation"),
      col("pipeline_category", "Category"),
      col("pipeline_damage", "Damage type"),
      col("pipeline_debris", "Debris"),
      num("anode_cp_value", "Anode CP mV"),
      col("anode_depletion", "Anode depletion"),
      col("anode_kp", "Anode KP"),
      col("remarks", "Remarks"),
    ],
  },
];

export const EXCEL_CONTRACT_BY_TYPE = new Map(EXCEL_CONTRACT.map((entry) => [entry.type, entry]));

export type ExcelRow = { resultId: number; cells: Record<string, ExcelCell> };

export type ExcelSheet = {
  type: InspectionTypeCode;
  sheet: string;
  columns: ExcelColumn[];
  rows: ExcelRow[];
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
  nominal_wall_mm: "",
};

/* ---------- panel text ---------- */

// The report's maps print shorter words (`Mid`, `Not present`, `Good`).
// The excel sheet repeats the panel's own text, so these maps stay local.
const PANEL_MEMBER: Record<string, string> = { chord: "Chord", brace: "Brace" };
const PANEL_MISALIGNED: Record<string, string> = { top: "Top", mid: "Mid-Section", bottom: "Bottom" };
const PANEL_COATING: Record<string, string> = { present: "Present", "not-present": "Not Present" };
const PANEL_COATING_STATE: Record<string, string> = {
  good: "Good Condition",
  "peel-off": "Coating Peel Off",
};
const PANEL_GROWTH: Record<string, string> = { soft: "Soft", hard: "Hard" };
const PANEL_CLASS: Record<string, string> = { normal: "Normal", anomaly: "Anomaly" };

// A presence flag reads as the panel's two choices.
const presence = (value: boolean | null) => (value === null ? "" : value ? "Present" : "Missing");

// Tools whose panel carries the shared Remark field. It ships last.
export const REMARK_TYPES: InspectionTypeCode[] = [
  "GVI",
  "CVI",
  "DVI",
  "CP",
  "FMD",
  "SCOUR",
  "CGB",
  "RISER",
  "CAISSON",
  "SEABED",
];

const REMARK_COLUMN: ExcelColumn = { key: "remark", label: "Remark", type: "text" };

// The columns a type's sheet ships: identity, the type's own columns, and the
// shared Remark field when the panel carries one.
export const sheetColumnsFor = (contract: ExcelTypeContract): ExcelColumn[] => [
  ...IDENTITY_COLUMNS,
  ...contract.columns,
  ...(REMARK_TYPES.includes(contract.type) ? [REMARK_COLUMN] : []),
];

// One reading's cells, and its own created_at when it has one.
type ShapedReading = { cells: Record<string, ExcelCell>; createdAt?: string };
type ShapedResult = { cells: Record<string, ExcelCell>; readings: ShapedReading[] };

// Result cells and one reading per child row. A type with no child list
// returns no readings, and the caller ships the result as a single row.
// flow: detail read > typed cells > reading rows
const shapeResult = async (
  resultId: number,
  type: InspectionTypeCode,
  database?: DbOrTx,
): Promise<ShapedResult> => {
  const empty: ShapedResult = { cells: {}, readings: [] };

  switch (type) {
    case "GVI": {
      const detail = await getGviDetailByResultId(resultId, database);
      if (!detail) return empty;

      // contact and proximity readings. A legacy row carries no method, so the
      // first free slot takes it, in panel order.
      let contact: GviCPFindingDetail | undefined;
      let proximity: GviCPFindingDetail | undefined;
      for (const finding of detail.cpFindings) {
        const slot = finding.cpMethod ?? (contact ? "proximity" : "contact");
        if (slot === "contact" && !contact) contact = finding;
        if (slot === "proximity" && !proximity) proximity = finding;
      }

      return {
        cells: {
          depth_el: number(detail.depthEl),
          gvi_contact: number(contact?.value),
          gvi_proximity: number(proximity?.value),
          gvi_cp_remark: txt(contact?.remark || proximity?.remark),
          condition: label(CONDITION_LABEL, detail.condition),
        },
        readings: (detail.mgi?.findings ?? []).map((finding) => ({
          cells: {
            mgi_depth: number(finding.depth),
            mgi_soft: number(finding.softCoveragePercent),
            mgi_hard: number(finding.hardCoveragePercent),
            mgi_remarks: txt(finding.remarks),
          },
          createdAt: finding.createdAt,
        })),
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
        readings: [],
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
        readings: [],
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
        readings: [],
      };
    }
    case "CVI": {
      const detail = await getCviDetailByResultId(resultId, database);
      if (!detail) return empty;
      const positions = detail.members.flatMap((member) =>
        member.positions.map((position) => ({
          cells: {
            member_type: label(PANEL_MEMBER, member.memberType),
            clock_position: position.clockPosition,
            ut_mm: number(position.utMm),
            findings: txt(position.findings),
          },
          createdAt: position.createdAt,
        })),
      );
      const cpFindings = detail.cpFindings.map((finding) => ({
        cells: {
          cp_potential_mv: number(finding.value),
          cp_remark: txt(finding.remark),
        },
        createdAt: finding.createdAt,
      }));
      // two parallel lists pair by order; the shorter one leaves blanks
      const count = Math.max(positions.length, cpFindings.length);
      return {
        cells: { datum_reference: txt(detail.datumReference) },
        readings: Array.from({ length: count }, (_, index) => {
          const position = positions[index];
          const cp = cpFindings[index];
          return {
            cells: { ...position?.cells, ...cp?.cells },
            createdAt: position?.createdAt ?? cp?.createdAt,
          };
        }),
      };
    }
    case "DVI": {
      const detail = await getDviDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          datum_reference: txt(detail.datumReference),
          member_type: label(PANEL_MEMBER, detail.memberType),
          cp_potential_mv: number(detail.cpPotentialMv),
        },
        readings: detail.positions.map((position) => ({
          cells: {
            clock_position: position.clockPosition,
            ut_mm: number(position.utMm),
            findings: txt(position.findings),
          },
          createdAt: position.createdAt,
        })),
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
        readings: detail.findings.map((finding) => ({
          cells: {
            growth_type: label(PANEL_GROWTH, finding.growthType),
            species: txt(finding.species),
            species_other_text: txt(finding.speciesOtherText),
            coverage_percent: number(finding.coveragePercent),
            thickness_mm: number(finding.thicknessMm),
            remarks: txt(finding.remarks),
          },
          createdAt: finding.createdAt,
        })),
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
          hinge_pin: presence(detail.hingePin),
          hinge_bolt_nut_quantity: number(detail.hingeBoltNutQuantity),
          liners: presence(detail.liners),
          inboard_gap_condition: label(GAP_LABEL, detail.inboardGapCondition),
          inboard_estimate_gap: number(detail.inboardEstimateGap),
          inboard_alignment_condition: label(ALIGN_LABEL, detail.inboardAlignmentCondition),
          inboard_misaligned_position: label(PANEL_MISALIGNED, detail.inboardMisalignedPosition),
          inboard_anomaly_recommendation: txt(detail.inboardAnomalyRecommendation),
          outboard_gap_condition: label(GAP_LABEL, detail.outboardGapCondition),
          outboard_estimate_gap: number(detail.outboardEstimateGap),
          outboard_alignment_condition: label(ALIGN_LABEL, detail.outboardAlignmentCondition),
          outboard_misaligned_position: label(PANEL_MISALIGNED, detail.outboardMisalignedPosition),
          outboard_anomaly_recommendation: txt(detail.outboardAnomalyRecommendation),
          clamp_missing_bolts: positions(detail.clampMissingBolts),
          clamp_missing_washers: positions(detail.clampMissingWashers),
          hinge_missing_bolts: positions(detail.hingeMissingBolts),
          hinge_missing_washers: positions(detail.hingeMissingWashers),
        },
        readings: [],
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
        readings: [],
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
          coating_status: label(PANEL_COATING, detail.coatingStatus),
          coating_condition: label(PANEL_COATING_STATE, detail.coatingCondition),
          knee_brace: label(YES_NO_LABEL, detail.kneeBrace),
          debris: label(YES_NO_LABEL, detail.debris),
          debris_type: txt(detail.debrisType),
          anomaly: label(YES_NO_LABEL, detail.anomaly),
          recommendation: txt(detail.recommendation),
          restricted_access: label(YES_NO_LABEL, detail.restrictedAccess),
        },
        readings: [],
      };
    }
    case "CAISSON": {
      const detail = await getCiDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {
          visual_damage:
            detail.visualDamage === null
              ? ""
              : detail.visualDamage
                ? "Visual Damage"
                : "Good Condition",
          visual_damage_recommendation: txt(detail.visualDamageRecommendation),
          debris_present: bool(detail.debrisPresent),
          debris_recommendation: txt(detail.debrisRecommendation),
          grating_present: bool(detail.gratingPresent),
          grating_blockage: label(BLOCKAGE_LABEL, detail.gratingBlockage),
          grating_anomaly_recommendation: txt(detail.gratingAnomalyRecommendation),
          associated_pipes: joined(detail.gviAssociatedPipes.map((pipe) => pipe.position)),
          associated_pipes_recommendation: txt(detail.associatedPipesRecommendation),
        },
        // one row per CP reading; the body cells repeat on each
        readings: detail.cpFindings.map((finding) => ({
          cells: {
            cp_mv: number(finding.cpMv),
            cp_remark: txt(finding.remarks),
          },
          createdAt: finding.createdAt,
        })),
      };
    }
    case "SEABED": {
      const detail = await getSeabedDetailByResultId(resultId, database);
      if (!detail) return empty;
      return {
        cells: {},
        readings: detail.findings.map((finding) => ({
          cells: {
            range_meters: number(finding.rangeMeters),
            fixes: txt(finding.fixes),
            debris: label(YES_NO_LABEL, finding.debris),
            debris_type: txt(finding.debrisType),
          },
          createdAt: finding.createdAt,
        })),
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
        readings: detail.findings.map((finding) => ({
          cells: {
            pipeline_category: txt(finding.category),
            pipeline_damage: txt(finding.damageType),
            pipeline_debris: txt(finding.debrisType),
            anode_cp_value: number(finding.anodeCpValue),
            anode_depletion: txt(finding.anodeDepletion),
            anode_kp: txt(finding.anodeKp),
            remarks: txt(finding.remarks),
          },
          createdAt: finding.createdAt,
        })),
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
    // a type-wide list: one column per custom label, whatever result brought it
    const customColumns: ExcelColumn[] = [];

    for (const record of picked) {
      if (rows.length >= maxRowsPerType) break;

      const target: TargetLabel =
        (record.descriptionId !== null
          ? byDescriptionId.get(record.descriptionId)
          : record.partCodeId !== null
            ? byPartCodeId.get(record.partCodeId)
            : undefined) ?? EMPTY_LABEL;

      const shaped = await shapeResult(record.resultId, contract.type, database);

      // custom values ride after the typed cells, one column per label
      const labels =
        record.inspectionFormId === null ? undefined : customLabels.get(record.inspectionFormId);
      const customCells = customCellsFor(record.customValues, labels, customColumns);

      // one row per reading, or one row for a result with no readings
      const readings: ShapedReading[] =
        shaped.readings.length > 0 ? shaped.readings : [{ cells: {} }];
      for (const reading of readings) {
        if (rows.length >= maxRowsPerType) break;
        rows.push({
          resultId: record.resultId,
          cells: {
            result_id: record.resultId,
            session: record.sessionId === null ? "" : (sessionNames.get(record.sessionId) ?? ""),
            task_code: target.task_code,
            description: target.description,
            part_code: target.part_code,
            class: label(PANEL_CLASS, record.resultClass),
            recorded: reading.createdAt ? new Date(reading.createdAt) : record.createdAt,
            ...shaped.cells,
            ...reading.cells,
            // the panel's shared Remark field, last of the typed columns
            ...(REMARK_TYPES.includes(contract.type) ? { remark: txt(record.remarks) } : {}),
            ...customCells,
          },
        });
      }
    }

    sheets.push({
      type: contract.type,
      sheet: contract.sheet,
      columns: [...sheetColumnsFor(contract), ...customColumns],
      rows,
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

// Per-type counts for the dialog's cards, from one target read.
export const countExcelResults = async (
  projectId: number,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
): Promise<Record<string, number>> => {
  const { sorted } = await loadTargets(projectId, targets, organizationId, database);

  const counts = Object.fromEntries(EXCEL_CONTRACT.map((entry) => [entry.type, 0])) as Record<
    string,
    number
  >;
  for (const record of sorted) {
    if (record.inspectionTypeCode in counts) counts[record.inspectionTypeCode]!++;
  }
  return counts;
};

// The dialog preview: same sheets, ten rows per type. A result can split at
// the cut, so the preview is a sample.
export const previewExcelExport = (
  projectId: number,
  types: InspectionTypeCode[],
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
) =>
  gatherExcelExport(projectId, types, targets, organizationId, database, PREVIEW_ROWS_PER_TYPE);
