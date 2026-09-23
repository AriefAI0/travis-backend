import { AppError } from "../../lib/error";
import { db, type DbOrTx } from "../client";
import {
  createInspectionFormFieldRecords,
  createInspectionFormRecord,
  findCurrentInspectionForm,
  listInspectionFormFieldRecordsByFormId,
} from "../repositories/inspection-form.repository";

export type FormDataType = "integer" | "decimal" | "text" | "boolean";

export type CustomFieldInput = {
  label: string;
  dataType: FormDataType;
  required?: boolean;
  displayOrder: number;
};

export type InspectionFormFieldRow = {
  inspectionFormFieldId: number;
  label: string;
  dataType: string;
  required: boolean;
  isBuiltin: boolean;
  displayOrder: number;
};

export type InspectionFormView = {
  inspectionFormId: number;
  inspectionTypeCode: string;
  version: number;
  fields: InspectionFormFieldRow[];
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
    { label: "Exposed pile", dataType: "text" },
    { label: "Exposed pile height", dataType: "decimal" },
    { label: "Height leg 1", dataType: "decimal" },
    { label: "Height midpoint", dataType: "decimal" },
    { label: "Height leg 2", dataType: "decimal" },
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

// save-on-confirm: one new version per request; old versions stay frozen
export const saveInspectionFormVersion = async (
  projectId: number,
  inspectionTypeCode: string,
  customFields: CustomFieldInput[],
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
  const form = await createFormVersion(
    projectId,
    inspectionTypeCode,
    current.version + 1,
    normalized,
    database,
  );
  const fields = await listInspectionFormFieldRecordsByFormId(form.inspectionFormId, database);
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
