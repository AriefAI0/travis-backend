import { and, asc, desc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "../client";
import { inspectionForm, inspectionFormField } from "../schema";

export const createInspectionFormRecord = async (
  data: typeof inspectionForm.$inferInsert,
  database: DbOrTx = db,
) => {
  const created = await database.insert(inspectionForm).values(data).returning();
  return created[0] ?? null;
};

// current version = max version per project + inspection type
export const findCurrentInspectionForm = async (
  projectId: number,
  inspectionTypeCode: (typeof inspectionForm.$inferInsert)["inspectionTypeCode"],
  database: DbOrTx = db,
) =>
  (await database.query.inspectionForm.findFirst({
    where: and(
      eq(inspectionForm.projectId, projectId),
      eq(inspectionForm.inspectionTypeCode, inspectionTypeCode),
    ),
    orderBy: [desc(inspectionForm.version)],
  })) ?? null;

export const findInspectionFormById = async (
  inspectionFormId: number,
  database: DbOrTx = db,
) =>
  (await database.query.inspectionForm.findFirst({
    where: eq(inspectionForm.inspectionFormId, inspectionFormId),
  })) ?? null;

export const createInspectionFormFieldRecords = async (
  data: (typeof inspectionFormField.$inferInsert)[],
  database: DbOrTx = db,
) => database.insert(inspectionFormField).values(data).returning();

export const listInspectionFormFieldRecordsByFormId = async (
  inspectionFormId: number,
  database: DbOrTx = db,
) =>
  database.query.inspectionFormField.findMany({
    where: eq(inspectionFormField.inspectionFormId, inspectionFormId),
    orderBy: [asc(inspectionFormField.displayOrder), asc(inspectionFormField.inspectionFormFieldId)],
  });
