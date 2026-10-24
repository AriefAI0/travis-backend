import { AppError } from "../../lib/error";
import type { Caller } from "../../lib/caller";
import type { InspectionFormFieldRow, InspectionFormView } from "../../types/api";
import { db, type DbOrTx } from "../client";
import {
  createInspectionFormFieldRecords,
  createInspectionFormRecord,
  findCurrentInspectionForm,
  findInspectionFormById,
  listInspectionFormFieldRecordsByFormId,
} from "../repositories/inspection-form.repository";
import { writeAudit } from "./audit.service";

export type { InspectionFormFieldRow, InspectionFormView };

export type FormDataType = "integer" | "decimal" | "text" | "boolean";

export type CustomFieldInput = {
  label: string;
  dataType: FormDataType;
  required?: boolean;
  displayOrder: number;
};

/* fixed built-in fields per inspection type, matching the tool forms;
   they never come from a request and can never be removed or changed */
const BUILTIN_FIELDS: Record<string, Array<{ label: string; dataType: FormDataType }>> = {
  GVI: [
    { label: "CP mV", dataType: "integer" },
    { label: "UT mm", dataType: "integer" },
    { label: "Condition", dataType: "text" },
  ],
  CVI: [
    { label: "Member type", dataType: "text" },
    { label: "Datum reference", dataType: "text" },
    { label: "CP potential mV", dataType: "integer" },
    { label: "Clock positions", dataType: "text" },
  ],
  DVI: [
    { label: "Member type", dataType: "text" },
    { label: "Datum reference", dataType: "text" },
    { label: "CP potential mV", dataType: "integer" },
    { label: "Clock positions", dataType: "text" },
  ],
  MGI: [
    { label: "Criteria preset", dataType: "text" },
    { label: "No MG observed", dataType: "boolean" },
    { label: "Findings", dataType: "text" },
  ],
  CP: [
    { label: "Anode type", dataType: "text" },
    { label: "Voltage mV", dataType: "integer" },
    { label: "Depletion", dataType: "text" },
    { label: "Anode width", dataType: "integer" },
    { label: "Anode height", dataType: "integer" },
    { label: "Anode length", dataType: "integer" },
    { label: "Widest pit", dataType: "integer" },
    { label: "Deepest pit", dataType: "integer" },
  ],
  FMD: [
    { label: "Depth EL", dataType: "decimal" },
    { label: "Initial attempt", dataType: "text" },
    { label: "Additional attempt 1", dataType: "text" },
    { label: "Additional attempt 2", dataType: "text" },
    { label: "Additional attempt 3", dataType: "text" },
  ],
  SCOUR: [
    { label: "Leg 1 location", dataType: "text" },
    { label: "Dim A", dataType: "decimal" },
    { label: "Dim B", dataType: "decimal" },
    { label: "Dim C", dataType: "decimal" },
    { label: "Leg 1 exposed", dataType: "boolean" },
    { label: "Leg 1 exposed height", dataType: "decimal" },
    { label: "Leg 2 location", dataType: "text" },
    { label: "Leg 2 exposed", dataType: "boolean" },
    { label: "Leg 2 exposed height", dataType: "decimal" },
  ],
  BSI: [
    { label: "Clamp type", dataType: "text" },
    { label: "Depth EL", dataType: "decimal" },
    { label: "Clamp bolts and nuts quantity", dataType: "integer" },
    { label: "Outboard clamp CP", dataType: "decimal" },
    { label: "Hinge pin", dataType: "boolean" },
    { label: "Hinge bolts and nuts quantity", dataType: "integer" },
    { label: "Liners", dataType: "boolean" },
    { label: "Inboard gap condition", dataType: "text" },
    { label: "Inboard estimate gap", dataType: "decimal" },
    { label: "Inboard alignment condition", dataType: "text" },
    { label: "Inboard misaligned position", dataType: "text" },
    { label: "Outboard gap condition", dataType: "text" },
    { label: "Outboard estimate gap", dataType: "decimal" },
    { label: "Outboard alignment condition", dataType: "text" },
    { label: "Outboard misaligned position", dataType: "text" },
  ],
};

export const builtinFieldCount = (inspectionTypeCode: string) =>
  BUILTIN_FIELDS[inspectionTypeCode]?.length ?? 0;

// insert one version: registry builtins first, then the custom rows
const createFormVersion = async (
  projectId: number,
  inspectionTypeCode: string,
  version: number,
  customFields: CustomFieldInput[],
  database?: DbOrTx,
) => {
  const builtins = BUILTIN_FIELDS[inspectionTypeCode] ?? [];
  const form =
    (await createInspectionFormRecord(
      { projectId, inspectionTypeCode: inspectionTypeCode as "GVI", version },
      database,
    )) ?? null;
  if (!form) throw new Error("Form version create failed");

  const rows = [
    ...builtins.map((field, index) => ({
      inspectionFormId: form.inspectionFormId,
      label: field.label,
      dataType: field.dataType,
      required: false,
      isBuiltin: true,
      displayOrder: index,
    })),
    ...customFields.map((field) => ({
      inspectionFormId: form.inspectionFormId,
      label: field.label,
      dataType: field.dataType,
      required: field.required ?? false,
      isBuiltin: false,
      displayOrder: field.displayOrder,
    })),
  ];
  await createInspectionFormFieldRecords(rows, database);
  return form;
};

// get-or-seed: first read creates version 1 with the builtin rows
export const getCurrentInspectionForm = async (
  projectId: number,
  inspectionTypeCode: string,
  database?: DbOrTx,
): Promise<InspectionFormView> => {
  let form = await findCurrentInspectionForm(
    projectId,
    inspectionTypeCode as "GVI",
    database,
  );
  if (!form) {
    form = await createFormVersion(projectId, inspectionTypeCode, 1, [], database);
  }
  const fields = await listInspectionFormFieldRecordsByFormId(form.inspectionFormId, database);
  return {
    inspectionFormId: form.inspectionFormId,
    inspectionTypeCode: form.inspectionTypeCode,
    version: form.version,
    fields: fields.map((field) => ({
      inspectionFormFieldId: field.inspectionFormFieldId,
      label: field.label,
      dataType: field.dataType,
      required: field.required,
      isBuiltin: field.isBuiltin,
      displayOrder: field.displayOrder,
    })),
  };
};

// one frozen form version, used to read and correct a completed result
export const getInspectionFormVersion = async (
  inspectionFormId: number,
  database?: DbOrTx,
): Promise<InspectionFormView | null> => {
  const form = await findInspectionFormById(inspectionFormId, database);
  if (!form) return null;

  const fields = await listInspectionFormFieldRecordsByFormId(inspectionFormId, database);
  return {
    inspectionFormId: form.inspectionFormId,
    inspectionTypeCode: form.inspectionTypeCode,
    version: form.version,
    fields: fields.map((field) => ({
      inspectionFormFieldId: field.inspectionFormFieldId,
      label: field.label,
      dataType: field.dataType,
      required: field.required,
      isBuiltin: field.isBuiltin,
      displayOrder: field.displayOrder,
    })),
  };
};

// check custom values against a pinned form version; returns the cleaned map
export const validateInspectionCustomValues = async (
  inspectionFormId: number,
  customValues: Record<string, unknown>,
  database?: DbOrTx,
): Promise<Record<string, unknown>> => {
  const fields = await listInspectionFormFieldRecordsByFormId(inspectionFormId, database);
  const byId = new Map(fields.map((field) => [String(field.inspectionFormFieldId), field]));
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(customValues)) {
    const field = byId.get(key);
    if (!field || field.isBuiltin) {
      throw new AppError(400, "custom_value_invalid", `customValues: unknown field ${key}`);
    }
    if (value === null || value === undefined) continue;
    const matches =
      (field.dataType === "integer" && Number.isInteger(value)) ||
      (field.dataType === "decimal" && typeof value === "number" && Number.isFinite(value)) ||
      (field.dataType === "text" && typeof value === "string") ||
      (field.dataType === "boolean" && typeof value === "boolean");
    if (!matches) {
      throw new AppError(400, "custom_value_invalid", `customValues: ${field.label} expects ${field.dataType}`);
    }
    values[key] = value;
  }

  for (const field of fields) {
    if (field.isBuiltin || !field.required) continue;
    const value = values[String(field.inspectionFormFieldId)];
    if (value === undefined || value === "") {
      throw new AppError(400, "custom_value_missing", `customValues: ${field.label} is required`);
    }
  }
  return values;
};

// save-on-confirm: one new version per request; old versions stay frozen
export const saveInspectionFormVersion = async (
  projectId: number,
  inspectionTypeCode: string,
  customFields: CustomFieldInput[],
  caller: Caller,
  database?: DbOrTx,
): Promise<InspectionFormView> => {
  const builtins = BUILTIN_FIELDS[inspectionTypeCode] ?? [];
  const builtinLabels = new Set(builtins.map((field) => field.label));

  const seen = new Set<string>();
  for (const field of customFields) {
    const label = field.label.trim();
    if (!label) throw new Error("Field label is required");
    if (builtinLabels.has(label)) {
      throw new AppError(400, "validation_error", `Field label ${label} is reserved`);
    }
    if (seen.has(label)) {
      throw new AppError(400, "validation_error", `Duplicate field label ${label}`);
    }
    seen.add(label);
  }

  const current = await getCurrentInspectionForm(projectId, inspectionTypeCode, database);
  const normalized = customFields.map((field) => ({ ...field, label: field.label.trim() }));

  // flow: insert the version and its fields > audit, one transaction
  const work = async (tx: DbOrTx): Promise<InspectionFormView> => {
    const form = await createFormVersion(
      projectId,
      inspectionTypeCode,
      current.version + 1,
      normalized,
      tx,
    );
    const fields = await listInspectionFormFieldRecordsByFormId(form.inspectionFormId, tx);

    await writeAudit(
      {
        organizationId: caller.organizationId,
        userId: caller.userId,
        action: "modify",
        resourceType: "InspectionForm",
        resourceId: form.inspectionFormId,
        after: { inspectionTypeCode, version: form.version, fields: normalized },
      },
      tx,
    );

    return {
      inspectionFormId: form.inspectionFormId,
      inspectionTypeCode: form.inspectionTypeCode,
      version: form.version,
      fields: fields.map((row) => ({
        inspectionFormFieldId: row.inspectionFormFieldId,
        label: row.label,
        dataType: row.dataType,
        required: row.required,
        isBuiltin: row.isBuiltin,
        displayOrder: row.displayOrder,
      })),
    };
  };

  // A caller-supplied transaction gets a single attempt.
  return database ? work(database) : db.transaction(work);
};
