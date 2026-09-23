import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import {
  getCurrentInspectionForm,
  saveInspectionFormVersion,
} from "../../db/services/inspection-form.service";
import { AppError } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { inspectionTypeParamSchema, saveInspectionFormSchema } from "../../types/api";

// project inspection forms: get-or-seed current version, save new versions
export const inspectionFormRoutes = (database?: DbOrTx) => {
  const routes = new Hono();

  // enum path param -> 400 on an unknown code
  const parseInspectionType = (raw: string) => {
    const parsed = inspectionTypeParamSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "validation_error", `inspectionType: expected one of GVI, CVI, MGI, CP, FMD, SCOUR`);
    }
    return parsed.data;
  };

  routes.get("/api/v1/projects/:projectId/inspection-forms/:inspectionType", async (c) => {
    const projectId = parseId(c, "projectId");
    const inspectionType = parseInspectionType(c.req.param("inspectionType"));
    return ok(c, await getCurrentInspectionForm(projectId, inspectionType, database));
  });

  routes.post(
    "/api/v1/projects/:projectId/inspection-forms/:inspectionType/versions",
    async (c) => {
      const projectId = parseId(c, "projectId");
      const inspectionType = parseInspectionType(c.req.param("inspectionType"));
      const input = await parseBody(c, saveInspectionFormSchema);
      return ok(c, await saveInspectionFormVersion(projectId, inspectionType, input.customFields, database), 201);
    },
  );

  return routes;
};
