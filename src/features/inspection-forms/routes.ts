import { Hono } from "hono";
import type { DbOrTx } from "../../db/client";
import { findProjectById } from "../../db/repositories/project.repository";
import {
  getCurrentInspectionForm,
  saveInspectionFormVersion,
} from "../../db/services/inspection-form.service";
import { callerOf, requireCan, requireUser, type AuthVariables } from "../../lib/auth/middleware";
import { AppError, notFound } from "../../lib/error";
import { parseBody, parseId } from "../../lib/parse";
import { ok } from "../../lib/response";
import { INSPECTION_TYPE_CODES, inspectionTypeParamSchema, saveInspectionFormSchema } from "../../types/api";

// project inspection forms: get-or-seed current version, save new versions
// flow: requireUser > requireCan > project in org > service > ok
//
// A form version decides what a result captures, so it carries Result.
// `modify Result` is held by both presets, so neither loses the form surface.
//
// Both routes sit under /api/v1/projects, a prefix other features also own, so
// each takes its guard inline. A wildcard here would guard their routes too.
export const inspectionFormRoutes = (database?: DbOrTx) => {
  const routes = new Hono<{ Variables: AuthVariables }>();

  // enum path param -> 400 on an unknown code
  const parseInspectionType = (raw: string) => {
    const parsed = inspectionTypeParamSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        400,
        "validation_error",
        `inspectionType: expected one of ${INSPECTION_TYPE_CODES.join(", ")}`,
      );
    }
    return parsed.data;
  };

  // A project in another org reads as absent, so the id can never be probed.
  const scopedProjectId = async (
    projectId: number,
    organizationId: number,
  ) => {
    if (!(await findProjectById(projectId, organizationId, database))) {
      throw notFound("Project");
    }
    return projectId;
  };

  routes.get(
    "/api/v1/projects/:projectId/inspection-forms/:inspectionType",
    requireUser(database),
    requireCan("read", "Result"),
    async (c) => {
      const projectId = await scopedProjectId(parseId(c, "projectId"), callerOf(c).organizationId);
      const inspectionType = parseInspectionType(c.req.param("inspectionType"));
      return ok(c, await getCurrentInspectionForm(projectId, inspectionType, database));
    },
  );

  routes.post(
    "/api/v1/projects/:projectId/inspection-forms/:inspectionType/versions",
    requireUser(database),
    requireCan("modify", "Result"),
    async (c) => {
      const projectId = await scopedProjectId(parseId(c, "projectId"), callerOf(c).organizationId);
      const inspectionType = parseInspectionType(c.req.param("inspectionType"));
      const input = await parseBody(c, saveInspectionFormSchema);
      return ok(c, await saveInspectionFormVersion(projectId, inspectionType, input.customFields, database), 201);
    },
  );

  return routes;
};
