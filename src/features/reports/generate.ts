// Report generation, off the request path.
//
// A render walks the whole task tree, reads every result and prefetches its
// images, so it runs after the route answers. The row carries the state and the
// dialog polls it.
// flow: insert row (generating) > render > store docx > flip ready, else error

import type { DbOrTx } from "../../db/client";
import { log } from "../../lib/logger";
import { createReport, saveReportDocx, setReportStatus } from "../../db/services/report.service";
import type { ReportRow } from "../../db/repositories/report.repository";
import { loadReportInputs, renderReport } from "./report-generator";

// The row exists before any bytes do, so a failed render still leaves the user
// something to see and delete.
const renderInto = async (row: ReportRow, database?: DbOrTx) => {
  try {
    const { template, data } = await loadReportInputs(row.projectId, database);
    const docx = await renderReport(template, data);

    // the row is still `generating`, so the version it was created with is
    // the one this write claims
    await saveReportDocx(row.reportId, docx, row.version, database);
    await setReportStatus(row.reportId, "ready", null, database);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("report render failed", { reportId: row.reportId, err: detail });

    // the row is the only record of the failure, so a missing one is not fatal
    await setReportStatus(row.reportId, "error", detail, database).catch(() => {});
  }
};

// Create the row the list will show, then render in the background.
export const queueReportGeneration = async (
  projectId: number,
  name: string,
  database?: DbOrTx,
): Promise<ReportRow> => {
  const row = await createReport(projectId, name, database);

  // never awaited: renderInto swallows its own errors, so this cannot reject
  void renderInto(row, database);

  return row;
};
