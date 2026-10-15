import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { appFor } from "../../helpers/app";
import { closeTestDatabase, ensureTestDatabase, testDb } from "../../helpers/db";
import { auditRoutes } from "../../../src/features/audit/routes";
import { editorRoutes } from "../../../src/features/reports/editor-page";
import { importRoutes } from "../../../src/features/import/routes";
import { inspectionFormRoutes } from "../../../src/features/inspection-forms/routes";
import { inspectionRoutes } from "../../../src/features/inspections/routes";
import { plannedInspectionRoutes } from "../../../src/features/planned-inspections/routes";
import { projectRoutes } from "../../../src/features/projects/routes";
import { recordingRoutes } from "../../../src/features/recording/routes";
import { reportRoutes } from "../../../src/features/reports/routes";
import { restrictedAccessRoutes } from "../../../src/features/restricted-access/routes";
import { resultRoutes } from "../../../src/features/results/routes";
import { sessionTimelineRoutes } from "../../../src/features/session-timeline/routes";
import { sessionRoutes } from "../../../src/features/sessions/routes";
import { taskStructureRoutes } from "../../../src/features/task-structure/routes";
import { userRoutes } from "../../../src/features/users/routes";

// Every /api/v1 surface mounted with a guard. One path each: the enumeration is
// the only way the "every route needs a user" claim holds when a new route or a
// new feature lands without one.
const app = appFor(
  testDb,
  userRoutes,
  auditRoutes,
  projectRoutes,
  taskStructureRoutes,
  plannedInspectionRoutes,
  restrictedAccessRoutes,
  inspectionFormRoutes,
  importRoutes,
  sessionTimelineRoutes,
  reportRoutes,
  editorRoutes,
  sessionRoutes,
  inspectionRoutes,
  recordingRoutes,
  resultRoutes,
);

const UUID = "00000000-0000-4000-8000-000000000000";

// One representative path per guarded feature. The versioned /api/v2 ingest and
// HLS surfaces are absent on purpose: they carry their own token.
const GUARDED = [
  "/api/v1/projects",
  "/api/v1/projects/1/tree",
  "/api/v1/projects/1/planned-inspections",
  "/api/v1/projects/1/restricted-access",
  "/api/v1/projects/1/inspection-forms/GVI",
  "/api/v1/projects/1/template",
  "/api/v1/sessions/1/results",
  "/api/v1/projects/1/reports",
  `/api/v1/reports/${UUID}`,
  "/api/v1/projects/1/sessions",
  "/api/v1/sessions/1/inspections/active",
  "/api/v1/recordings/unfinished",
  "/api/v1/descriptions/1/results",
  "/api/v1/audit-logs",
  "/api/v1/users",
];

describe("api guards", () => {
  beforeAll(ensureTestDatabase);
  afterAll(closeTestDatabase);

  for (const path of GUARDED) {
    it(`answers 401 for ${path} with no token`, async () => {
      const res = await app.request(path);

      expect(res.status).toBe(401);
    });
  }
});
