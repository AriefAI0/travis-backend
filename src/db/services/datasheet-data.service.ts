// Everything one datasheet needs: header fields, ordered rows, column names.
//
// The app sends target keys, never result ids: a ticked tree row names a
// target, and every non-RA result under it belongs on the sheet.
// flow: target keys > results > tree order > per-kind rows > table
import type { DbOrTx } from "../client";
import { AppError } from "../../lib/error";
import {
  datasheetKinds,
  type DatasheetKind,
  type InspectionTypeCode,
} from "../../types/api";
import { listResultRecordsByTargetIds } from "../repositories/result.repository";
import { getProjectById } from "./project.service";
import { listSessionsByIds } from "./session.service";
import { listProjectTaskStructureTree } from "./task-structure.service";
import {
  collectTargets,
  rowsForResult,
  type ResultRowInput,
  type TargetLabel,
} from "./report-data.service";

export const DATASHEET_KINDS = datasheetKinds;
export type { DatasheetKind };

// One generate holds this many results. Detail reads run per result, so the cap
// keeps one job bounded. ponytail: raise it when detail reads batch by type.
export const MAX_DATASHEET_RESULTS = 500;

// The tick a datasheet cell carries where a form had a choice.
const TICK = "√";

type KindSpec = {
  // the result type the card reads; CP-MEMBER is the CVI datasheet
  type: InspectionTypeCode;
  columns: string[];
};

export const KIND_SPECS: Record<DatasheetKind, KindSpec> = {
  GVI: {
    type: "GVI",
    columns: ["component_id", "component_type", "depth_el", "condition", "remarks"],
  },
  CP_ANODE: {
    type: "CP",
    columns: [
      "component_id",
      "anode_type",
      "voltage_mv",
      "depletion",
      "anode_width",
      "anode_height",
      "anode_length",
      "widest_pit",
      "deepest_pit",
      "remarks",
    ],
  },
  CP_MEMBER: {
    type: "CVI",
    columns: [
      "component_id",
      "cp_mv",
      "wall_mm",
      "clock_12",
      "clock_3",
      "clock_6",
      "clock_9",
      "remarks",
    ],
  },
  FMD: {
    type: "FMD",
    columns: [
      "component_id",
      "component_type",
      "depth_el",
      "initial_attempt",
      "additional_attempt_1",
      "additional_attempt_2",
      "additional_attempt_3",
      "remarks",
    ],
  },
  SCOUR: {
    type: "SCOUR",
    columns: [
      "location_leg1",
      "dim_a",
      "dim_b",
      "dim_c",
      "exp_leg1",
      "height_exp_leg1",
      "location_leg2",
      "exp_leg2",
      "height_exp_leg2",
    ],
  },
  // no template file ships yet; the card stays disabled until one lands
  DVI: {
    type: "DVI",
    columns: ["component_id", "cp_mv", "wall_mm", "clock_12", "clock_3", "clock_6", "clock_9", "remarks"],
  },
};

export type DatasheetHeader = {
  Client: string;
  ReportNo: string;
  Date: string;
  Session: string;
};

export type DatasheetTable = {
  kind: DatasheetKind;
  header: DatasheetHeader;
  columns: string[];
  rows: Record<string, string>[];
};

export type DatasheetTargets = { descriptionIds: number[]; partCodeIds: number[] };

// An empty label, for a result whose target left the tree.
const EMPTY_LABEL: TargetLabel = {
  task_group: "",
  task_code: "",
  description: "",
  type_code: "",
  part_code: "",
};

// The two key spellings the app sends, one per tree row kind.
const TARGET_KEY = /^(description|partCode):([1-9]\d*)$/;

// Split target keys into the two id lists the repository reads.
export const parseDatasheetTargets = (targets: string[]): DatasheetTargets => {
  const descriptionIds = new Set<number>();
  const partCodeIds = new Set<number>();

  for (const key of targets) {
    const match = TARGET_KEY.exec(key);
    if (!match) {
      throw new AppError(400, "invalid_target", `Target "${key}" is not description:<id> or partCode:<id>`);
    }
    const id = Number(match[2]);
    (match[1] === "description" ? descriptionIds : partCodeIds).add(id);
  }

  return { descriptionIds: [...descriptionIds], partCodeIds: [...partCodeIds] };
};

// What the sheet header can fill. Anything else stays blank.
const headerFor = async (
  title: string,
  documentId: string | null,
  sessionIds: number[],
  database?: DbOrTx,
): Promise<DatasheetHeader> => {
  const sessions = sessionIds.length === 1 ? await listSessionsByIds(sessionIds, database) : [];

  return {
    Client: title,
    ReportNo: documentId ?? "",
    Date: new Date().toISOString().slice(0, 10),
    Session: sessions[0]?.name ?? "",
  };
};

// Label a result carries: its target's part code, else its description.
const componentId = (label: TargetLabel) => label.part_code || label.description;

// A record shaped for the sheet, from the report row of its type.
const shapeRow = (
  kind: DatasheetKind,
  row: Record<string, string>,
  label: TargetLabel,
): Record<string, string> => {
  const id = componentId(label);

  switch (kind) {
    case "GVI":
      return {
        component_id: id,
        component_type: label.type_code,
        depth_el: row.depth_el ?? "",
        condition: row.condition ?? "",
        remarks: row.remarks ?? "",
      };
    case "CP_ANODE":
      return {
        component_id: id,
        anode_type: row.anode_type ?? "",
        voltage_mv: row.voltage_mv ?? "",
        depletion: row.depletion ?? "",
        anode_width: row.anode_width ?? "",
        anode_height: row.anode_height ?? "",
        anode_length: row.anode_length ?? "",
        widest_pit: row.widest_pit ?? "",
        deepest_pit: row.deepest_pit ?? "",
        remarks: row.remarks ?? "",
      };
    case "CP_MEMBER": {
      // one row per member position, then one per CP finding; both carry the
      // reading in cp_potential_mv and the note in findings
      const clock = row.clock_position ?? "";
      const tick = (hour: string) =>
        new RegExp(`\\b${hour}\\b`).test(clock) ? TICK : "";
      return {
        component_id: id,
        cp_mv: row.cp_potential_mv ?? "",
        wall_mm: row.ut_mm ?? "",
        clock_12: tick("12"),
        clock_3: tick("3"),
        clock_6: tick("6"),
        clock_9: tick("9"),
        remarks: row.findings ?? "",
      };
    }
    case "FMD":
      // the form records Dry, Flooded or N/A per attempt; the sheet repeats it
      return {
        component_id: id,
        component_type: label.type_code,
        depth_el: row.depth_el ?? "",
        initial_attempt: row.initial_attempt ?? "",
        additional_attempt_1: row.additional_attempt_1 ?? "",
        additional_attempt_2: row.additional_attempt_2 ?? "",
        additional_attempt_3: row.additional_attempt_3 ?? "",
        remarks: row.remarks ?? "",
      };
    case "SCOUR":
      return {
        location_leg1: row.location_leg1 ?? "",
        dim_a: row.dim_a ?? "",
        dim_b: row.dim_b ?? "",
        dim_c: row.dim_c ?? "",
        exp_leg1: row.exp_leg1 ?? "",
        height_exp_leg1: row.height_exp_leg1 ?? "",
        location_leg2: row.location_leg2 ?? "",
        exp_leg2: row.exp_leg2 ?? "",
        height_exp_leg2: row.height_exp_leg2 ?? "",
      };
    case "DVI":
      return {
        component_id: id,
        cp_mv: "",
        wall_mm: "",
        clock_12: "",
        clock_3: "",
        clock_6: "",
        clock_9: "",
        remarks: row.findings ?? "",
      };
  }
};

// One target set, read once: the project, its live results in tree order, and
// the labels each result carries.
const loadTargets = async (
  projectId: number,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
) => {
  if (!Number.isInteger(projectId) || projectId < 1) {
    throw new AppError(400, "invalid_project_id", "Project id must be a positive integer");
  }

  const project = await getProjectById(projectId, { organizationId, userId: null }, database);
  if (!project) {
    throw new AppError(404, "project_not_found", `No project with id ${projectId}`);
  }

  const [groups, records] = await Promise.all([
    listProjectTaskStructureTree(projectId, { organizationId, userId: null }, database),
    listResultRecordsByTargetIds(targets.descriptionIds, targets.partCodeIds, database),
  ]);

  // RA is a gap mark, not an inspection result, so it never reaches a sheet
  const results = records.filter((record) => record.inspectionTypeCode !== "RA");
  if (results.length > MAX_DATASHEET_RESULTS) {
    throw new AppError(
      413,
      "too_many_results",
      `${results.length} results selected; one datasheet holds at most ${MAX_DATASHEET_RESULTS}`,
    );
  }

  const { byDescriptionId, byPartCodeId, order } = collectTargets(groups);
  const rank = new Map(order.map((key, index) => [key, index]));

  // tree order first, then the order the rows were created
  const keyOf = (record: (typeof results)[number]) =>
    record.descriptionId !== null ? `description:${record.descriptionId}` : `partCode:${record.partCodeId}`;
  const sorted = [...results].sort(
    (a, b) => (rank.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER),
  );

  return { project, sorted, byDescriptionId, byPartCodeId, keyOf };
};

// Every card's count for the picked targets, so the dialog draws once.
export const countDatasheetResults = async (
  projectId: number,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
): Promise<Record<DatasheetKind, number>> => {
  const { sorted } = await loadTargets(projectId, targets, organizationId, database);

  const counts = Object.fromEntries(DATASHEET_KINDS.map((kind) => [kind, 0])) as Record<
    DatasheetKind,
    number
  >;
  for (const record of sorted) {
    for (const kind of DATASHEET_KINDS) {
      if (KIND_SPECS[kind].type === record.inspectionTypeCode) counts[kind]++;
    }
  }
  return counts;
};

// The full sheet for one kind: header, ordered rows, column names.
// `maxRows` stops the detail reads once a preview has enough.
export const gatherDatasheet = async (
  projectId: number,
  kind: DatasheetKind,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
  maxRows = Number.POSITIVE_INFINITY,
): Promise<DatasheetTable> => {
  const { project, sorted, byDescriptionId, byPartCodeId, keyOf } = await loadTargets(
    projectId,
    targets,
    organizationId,
    database,
  );

  const spec = KIND_SPECS[kind];
  const picked = sorted.filter((record) => record.inspectionTypeCode === spec.type);

  const rows: Record<string, string>[] = [];
  for (const record of picked) {
    if (rows.length >= maxRows) break;
    const key = keyOf(record);
    const label =
      record.descriptionId !== null
        ? byDescriptionId.get(record.descriptionId)
        : record.partCodeId !== null
          ? byPartCodeId.get(record.partCodeId)
          : undefined;
    const input: ResultRowInput = {
      resultId: record.resultId,
      inspectionTypeCode: record.inspectionTypeCode,
      remarks: record.remarks,
      createdAt: record.createdAt.toISOString(),
    };

    for (const row of await rowsForResult(input, database)) {
      rows.push(shapeRow(kind, row, label ?? EMPTY_LABEL));
    }
  }

  const sessionIds = [...new Set(picked.map((record) => record.sessionId))].filter(
    (id): id is number => id !== null,
  );

  return {
    kind,
    header: await headerFor(project.title, project.documentId, sessionIds, database),
    columns: spec.columns,
    rows,
  };
};

// The dialog's preview: the same rows, cut to what one card shows.
export const previewDatasheet = async (
  projectId: number,
  kind: DatasheetKind,
  targets: DatasheetTargets,
  organizationId: number,
  database?: DbOrTx,
  limit = 10,
): Promise<DatasheetTable> =>
  gatherDatasheet(projectId, kind, targets, organizationId, database, limit);
