// Datasheet generation, off the request path.
//
// The row carries the state and the dialog polls it. A burst of generates
// lines up behind the one shared render slot.
// flow: row (generating) > queue > gather > render > pdf > store > ready
import type { DbOrTx } from "../../db/client";
import type { Caller } from "../../lib/caller";
import { AppError } from "../../lib/error";
import { log } from "../../lib/logger";
import { blankMissingValue, renderTemplate } from "../../lib/docx/render";
import { templatesDir } from "../../lib/docx/templates";
import { convertDocxToPdf } from "../../lib/pdf/convert";
import { enqueueRender } from "../../lib/render-queue";
import {
  gatherDatasheet,
  parseDatasheetTargets,
  type DatasheetTable,
} from "../../db/services/datasheet-data.service";
import {
  createDatasheet,
  setDatasheetStatus,
  storeDatasheet,
} from "../../db/services/datasheet.service";
import { systemCaller } from "../../db/services/report.service";
import type { DatasheetRow } from "../../db/repositories/datasheet.repository";
import type { DatasheetKind } from "../../types/api";

// The tagged file each card renders. DVI has none yet, so its card is disabled.
const TEMPLATE_FILES: Record<DatasheetKind, string | null> = {
  GVI: "gvi.docx",
  CP_ANODE: "cp_anode.docx",
  CP_MEMBER: "cp_member.docx",
  FMD: "fmd.docx",
  SCOUR: "scour.docx",
  DVI: null,
  UT: "ut.docx",
};

// A card with no template cannot generate. Callers check before creating a row.
export const hasDatasheetTemplate = (kind: DatasheetKind) => TEMPLATE_FILES[kind] !== null;

// The template a card renders, read from the bundled templates folder.
const templateFor = async (kind: DatasheetKind): Promise<Buffer> => {
  const file = TEMPLATE_FILES[kind];
  if (!file) {
    throw new AppError(400, "datasheet_template_missing", `No datasheet template ships for ${kind}`);
  }

  const bundled = Bun.file(templatesDir(`datasheets/${file}`));
  if (!(await bundled.exists())) {
    throw new AppError(500, "datasheet_template_missing", `templates/datasheets/${file} is gone`);
  }

  return Buffer.from(await bundled.arrayBuffer());
};

// The tags the template reads: header fields plus the row loop.
const renderData = (table: DatasheetTable) => ({
  ...table.header,
  rows: table.rows,
  // the scour sheet loops the whole outer row, picture and all
  scour_rows: table.rows,
});

// Render, convert, store. A failed PDF conversion degrades: the docx still
// ships and the row reports why the PDF is missing.
const renderInto = async (row: DatasheetRow, database?: DbOrTx) => {
  try {
    await enqueueRender(async () => {
      const [template, table] = await Promise.all([
        templateFor(row.kind as DatasheetKind),
        gatherDatasheet(
          row.projectId,
          row.kind as DatasheetKind,
          parseDatasheetTargets(row.targets),
          row.organizationId,
          database,
        ),
      ]);

      const docx = await renderTemplate(template, renderData(table), {
        nullGetter: blankMissingValue,
      });

      let pdf: Buffer | null = null;
      let pdfError: string | null = null;
      try {
        pdf = await convertDocxToPdf(docx);
      } catch (err) {
        pdfError = err instanceof Error ? err.message : String(err);
        log.warn("datasheet pdf failed", { datasheetId: row.datasheetId, err: pdfError });
      }

      await storeDatasheet(row, docx, pdf, pdfError, database);
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("datasheet render failed", { datasheetId: row.datasheetId, err: detail });

    // the row is the only record of the failure, so a missing one is not fatal
    await setDatasheetStatus(row.organizationId, row.datasheetId, "error", detail, database).catch(
      () => {},
    );
  }
};

// Create the row the list will show, then render in the background.
export const queueDatasheetGeneration = async (
  projectId: number,
  kind: DatasheetKind,
  targets: string[],
  name: string,
  caller: Caller,
  database?: DbOrTx,
): Promise<DatasheetRow> => {
  const row = await createDatasheet(projectId, kind, targets, name, caller, database);

  // never awaited: renderInto swallows its own errors, so this cannot reject
  void renderInto(row, database);

  return row;
};
