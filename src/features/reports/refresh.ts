// Region refresh: pull new inspection data into a report a user has edited.
//
// The stored document carries one tagged region per generated section. A
// refresh renders the project as it stands now and swaps each region's content,
// so every edit outside a region survives. The regions it could not place come
// back in the answer: a partial refresh that reads as a full one is worse than
// a refused one.
// flow: guard > stored docx > render > splice > save at the loaded version

import type { DbOrTx } from "../../db/client";
import {
  getReport,
  loadReportDocx,
  saveReportDocx,
  setReportStatus,
} from "../../db/services/report.service";
import { AppError } from "../../lib/error";
import { spliceRegions, type RegionSplice } from "../../lib/docx/regions";
import { loadReportInputs, renderReport } from "./report-generator";

export type RefreshReport = RegionSplice & { reportId: string; version: number };

// ponytail: the render runs inside the request, because the caller needs the
// region report in the answer. A project whose render grows past a few seconds
// belongs behind the job tracker, with the regions read back from the row.
export const refreshReport = async (
  reportId: string,
  database?: DbOrTx,
): Promise<RefreshReport> => {
  const row = await getReport(reportId, database);
  if (row.status === "generating") {
    throw new AppError(409, "report_not_ready", "The report is still generating");
  }

  const stored = await loadReportDocx(reportId, database);

  await setReportStatus(reportId, "generating", null, database);
  try {
    const { template, data } = await loadReportInputs(row.projectId, database);
    const fresh = await renderReport(template, data);
    const { docx, result } = spliceRegions(stored, fresh);

    // The claim rides the version guard the editor's save uses, so a save that
    // lands mid-refresh wins and this reports the conflict instead of undoing it.
    const written = await saveReportDocx(reportId, docx, row.version, database);
    await setReportStatus(reportId, "ready", null, database);

    return { reportId, version: written.version, ...result };
  } catch (err) {
    // The stored document is written only after the splice succeeds, so a
    // failed refresh leaves the report exactly as it was — never `error`, which
    // would read as a damaged document.
    await setReportStatus(reportId, "ready", null, database).catch(() => {});
    throw err;
  }
};
