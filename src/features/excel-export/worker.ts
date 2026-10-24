// The export worker: one lane for workbooks, one for clip merges.
//
// Each lane claims the oldest queued row and runs it to a terminal status. A
// claim sets the package key before any upload, so a cancel or a crash knows
// what to remove. Every move is a compare-and-set; a write that matches no row
// means the export was removed meanwhile, and the package goes with it.
// flow: wake > claim > gather > build > upload > compare-and-set

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { publish } from "../../lib/events/bus";
import { minio } from "../../lib/minio_storage/clients";
import { parseDatasheetTargets } from "../../db/services/datasheet-data.service";
import {
  gatherExcelExport,
  type ExcelExportData,
  type ExcelSheet,
  type ProgressCallback,
} from "../../db/services/excel-export-data.service";
import {
  claimExcelExport,
  getExcelExport,
  moveExcelExport,
  sweepExcelExports,
  type ExcelExportView,
} from "../../db/services/excel-export.service";
import type { InspectionTypeCode } from "../../types/api";
import { collectClips } from "./clips";
import { collectImages } from "./images";
import { bufferEntry, textEntry, resultFolder, writePackage, type PackageEntry } from "./package";
import {
  exportFilename,
  shippedStem,
  typeFilename,
  writeTypeWorkbook,
  type MediaCells,
} from "./workbook";

const LANES = ["light", "clips"] as const;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Progress reaches the bell at most once a second; a terminal status always goes.
const PROGRESS_INTERVAL_MS = 1_000;

// Retention sweep cadence. A package past seven days leaves quietly.
const SWEEP_INTERVAL_MS = 10 * 60 * 1_000;

// The key is minted before the claim, so it cannot carry the row id.
const packageKeyFor = (lane: (typeof LANES)[number], extension: string) =>
  `excel-exports/${lane}/${randomUUID()}.${extension}`;

// flow: org > resource > owner, so only the owner's streams take it
const emit = (row: ExcelExportView, action: "create" | "modify") =>
  excelWorkerDeps.emit(row, action);

// One run's progress: phase-aware writes through the existing CAS move,
// throttled to one a second, with the boundaries forced through.
export type ProgressReporter = {
  results: ProgressCallback;
  media: ProgressCallback;
  packing: () => Promise<void>;
  // the finished row reads `N results`, whatever the last phase counted
  resultCount: () => number;
};

export const progressReporter = (row: ExcelExportView): ProgressReporter => {
  let phase = "";
  let done = 0;
  let total = 0;
  let resultsTotal = 0;
  let lastWrite = 0;
  // false once the row leaves running: cancelled or removed mid-build
  let live = true;
  // writes chain, so overlapping callbacks never race a row update
  let writing: Promise<void> = Promise.resolve();

  const write = async (force: boolean) => {
    if (!live) return;
    if (!force && Date.now() - lastWrite < PROGRESS_INTERVAL_MS) return;
    lastWrite = Date.now();
    try {
      live = await excelWorkerDeps.move(row.id, "running", {
        phase,
        itemsDone: done,
        itemsTotal: total,
      });
    } catch (error) {
      log.warn("excel export progress write failed", { id: row.id, err: String(error) });
      return;
    }
    if (live) emit(row, "modify");
  };

  const onPhase = (name: string): ProgressCallback => async (nextDone, nextTotal) => {
    // a phase change, a new total, or the last item always lands
    const force = name !== phase || nextTotal !== total || nextDone === nextTotal;
    phase = name;
    if (name === "results") resultsTotal = nextTotal;
    done = nextDone;
    total = nextTotal;
    const next = writing.then(() => write(force));
    writing = next.catch(() => {});
    await next;
  };

  return {
    results: onPhase("results"),
    media: onPhase("media"),
    // packing keeps the last counts: its length is not known up front
    packing: async () => {
      phase = "packing";
      const next = writing.then(() => write(true));
      writing = next.catch(() => {});
      await next;
    },
    resultCount: () => resultsTotal,
  };
};

// The seams the tests replace: the row store, the gather, and object storage.
export type ExcelWorkerDeps = {
  claim: typeof claimExcelExport;
  move: typeof moveExcelExport;
  read: (id: string, organizationId: number, ownerUserId: string) => Promise<ExcelExportView>;
  gather: typeof gatherExcelExport;
  build: typeof writeTypeWorkbook;
  package: typeof writePackage;
  putObject: (key: string, body: Buffer) => Promise<void>;
  removeObject: (key: string) => Promise<void>;
  emit: (row: ExcelExportView, action: "create" | "modify") => void;
};

const defaultDeps: ExcelWorkerDeps = {
  claim: claimExcelExport,
  move: moveExcelExport,
  read: getExcelExport,
  gather: gatherExcelExport,
  build: writeTypeWorkbook,
  package: writePackage,
  putObject: async (key, body) =>
    void (await minio.putObject(env.BUCKET_MEDIA, key, body, body.length, {
      "Content-Type": XLSX_MIME,
    })),
  removeObject: async (key) => void (await minio.removeObject(env.BUCKET_MEDIA, key)),
  emit: (row, action) =>
    publish({
      organizationId: row.organizationId,
      action,
      resourceType: "ExcelExport",
      resourceId: row.id,
      userId: row.ownerUserId,
    }),
};

export const excelWorkerDeps: ExcelWorkerDeps = { ...defaultDeps };

// Restore the production seams after a test swapped them.
export const resetExcelWorkerDeps = () => Object.assign(excelWorkerDeps, defaultDeps);

const removePackage = async (key: string | null) => {
  if (!key) return;
  await excelWorkerDeps.removeObject(key).catch((error) => {
    log.warn("excel export package remove failed", { key, err: String(error) });
  });
};

// What one export produces: a bare workbook, or a zip of media beside it.
type BuiltPackage =
  | { kind: "xlsx"; body: Buffer; name: string; errors: string[] }
  | { kind: "zip"; entries: PackageEntry[]; name: string; errors: string[] };

const MIB = 1024 ** 2;

// The README that ships first: the layout, the gaps, and the tools that open
// a ZIP64 archive.
const readmeLines = (data: ExcelExportData, root: string, files: number, errors: string[]) => [
  "Travis excel export",
  "",
  `Project: ${data.projectTitle}`,
  `Export name: ${root}`,
  `Document: ${data.documentId || "-"}`,
  `Generated: ${new Date().toISOString()}`,
  `Media files: ${files}`,
  "",
  `One top folder, then one folder per ticked inspection type:`,
  `  ${root}/<TYPE>/<TYPE>_<export name>.xlsx   the workbook`,
  `  ${root}/<TYPE>/images/<result folder>/        one folder per result`,
  `  ${root}/<TYPE>/clips/<result folder>/         one folder per result`,
  "",
  ...(errors.length > 0 ? ["Missing files:", ...errors.map((line) => `- ${line}`), ""] : []),
  "Windows Explorer and 7-Zip open this archive.",
  "macOS Archive Utility does not open a ZIP64 archive: use 7-Zip or Keka.",
];

// One entry per result. Flat rows repeat a result, so media fetches once.
export type ResultTarget = { resultId: number; type: InspectionTypeCode; folder: string };

export const resultTypesOf = (data: ExcelExportData): ResultTarget[] => {
  const seen = new Set<number>();
  const list: ResultTarget[] = [];
  for (const sheet of data.sheets) {
    for (const row of sheet.rows) {
      if (seen.has(row.resultId)) continue;
      seen.add(row.resultId);
      list.push({
        resultId: row.resultId,
        type: sheet.type,
        folder: resultFolder(row.resultId, String(row.cells.task_code ?? ""), String(row.cells.description ?? "")),
      });
    }
  }
  return list;
};

// The folder references each result's rows carry, counted from what shipped.
export const mediaCellsFor = (
  targets: ResultTarget[],
  images: Map<number, number>,
  clips: Map<number, number>,
): Map<number, MediaCells> =>
  new Map(
    targets.map((target) => {
      const imageCount = images.get(target.resultId) ?? 0;
      const clipCount = clips.get(target.resultId) ?? 0;
      return [
        target.resultId,
        {
          imageFolder: imageCount > 0 ? `images/${target.folder}` : "",
          images: imageCount,
          clipFolder: clipCount > 0 ? `clips/${target.folder}` : "",
          clips: clipCount,
        },
      ] as const;
    }),
  );

// A count of shipped files per result.
const countByResult = (files: { resultId: number }[]) => {
  const counts = new Map<number, number>();
  for (const file of files) counts.set(file.resultId, (counts.get(file.resultId) ?? 0) + 1);
  return counts;
};

// One workbook per type, inside its type folder under the export's stem.
const workbookEntries = async (
  sheets: ExcelSheet[],
  stem: string,
  generatedAt: Date,
  media?: Map<number, MediaCells>,
): Promise<PackageEntry[]> => {
  const entries: PackageEntry[] = [];
  for (const sheet of sheets) {
    const body = await excelWorkerDeps.build(sheet, { generatedAt, media });
    entries.push(bufferEntry(`${stem}/${sheet.type}/${typeFilename(sheet.type, stem)}`, body));
  }
  return entries;
};

// flow: gather > (media: images > thumbnails) > one workbook per type > entries
const buildPackage = async (
  row: ExcelExportView,
  signal: AbortSignal,
  report?: ProgressReporter,
): Promise<BuiltPackage> => {
  const data = await excelWorkerDeps.gather(
    row.projectId,
    row.types as InspectionTypeCode[],
    parseDatasheetTargets(row.targets),
    row.organizationId,
    undefined,
    undefined,
    report?.results,
  );

  // a type with no rows gets no folder. Nothing at all still ships one sheet.
  const withRows = data.sheets.filter((sheet) => sheet.rows.length > 0);
  const sheets = withRows.length > 0 ? withRows : data.sheets.slice(0, 1);
  const generatedAt = new Date();
  // the user's typed name is the whole stem; a blank one keeps project and day.
  // every entry sits inside one top folder, so Extract All stays tidy
  const root = shippedStem(row.name, data.projectTitle, generatedAt);

  if (row.media === "raw") {
    // one type opens straight from the download, no zip around it
    if (sheets.length === 1) {
      const sheet = sheets[0]!;
      const body = await excelWorkerDeps.build(sheet, { generatedAt });
      return {
        kind: "xlsx",
        body,
        name: typeFilename(sheet.type, root),
        errors: [],
      };
    }

    return {
      kind: "zip",
      entries: [
        textEntry(`${root}/README.txt`, `${readmeLines(data, root, 0, []).join("\n")}\n`),
        ...(await workbookEntries(sheets, root, generatedAt)),
      ],
      name: exportFilename(root, "raw"),
      errors: [],
    };
  }

  const scratch = path.join(env.EXCEL_EXPORT_SCRATCH_DIR, row.id);
  const resultTypes = resultTypesOf(data);

  // images and clips share the media phase; clips count past the images, and
  // the total grows once the clip count is known
  let mediaBase = 0;
  const onImage = report
    ? async (imageDone: number, imageTotal: number) => {
        if (imageDone === imageTotal) mediaBase = imageTotal;
        await report.media(imageDone, imageTotal);
      }
    : undefined;
  const onClip = report
    ? async (clipDone: number, clipTotal: number) =>
        report.media(mediaBase + clipDone, mediaBase + clipTotal)
    : undefined;

  const imagePlan =
    row.media === "images" || row.media === "clips"
      ? await collectImages(resultTypes, scratch, signal, onImage)
      : { files: [], rows: [], errors: [] };

  // clip merges run after the images, one at a time, inside the clips lane
  const clipPlan =
    row.media === "clips"
      ? await collectClips(resultTypes, scratch, signal, onClip)
      : { files: [], rows: [], errors: [] };

  // the sheet names each result's folders and counts what shipped
  const media = mediaCellsFor(
    resultTypes,
    countByResult(imagePlan.files),
    countByResult(clipPlan.files),
  );

  const mediaFiles = imagePlan.files.flatMap((file) => {
    const entries: PackageEntry[] = [
      { name: `${root}/${file.raw.name}`, open: () => Readable.from(Bun.file(file.raw.file).stream()) },
    ];
    const annotated = file.annotated;
    if (annotated) {
      entries.push({
        name: `${root}/${annotated.name}`,
        open: () => Readable.from(Bun.file(annotated.file).stream()),
      });
    }
    return entries;
  });

  // a merged clip streams out of scratch like an image does
  const clipFiles: PackageEntry[] = clipPlan.files.map((file) => ({
    name: `${root}/${file.name}`,
    open: () => Readable.from(Bun.file(file.file).stream()),
  }));

  const errors = [...imagePlan.errors, ...clipPlan.errors];
  const entries: PackageEntry[] = [
    textEntry(`${root}/README.txt`, `${readmeLines(data, root, imagePlan.rows.length + clipPlan.rows.length, errors).join("\n")}\n`),
    ...mediaFiles,
    ...clipFiles,
    ...(await workbookEntries(sheets, root, generatedAt, media)),
  ];

  // a missing image or clip is a delivered package with a stated gap
  return {
    kind: "zip",
    entries,
    name: exportFilename(root, row.media),
    errors,
  };
};

// Move one claimed row to a terminal status, or leave it cancelled.
export const runExcelExport = async (claimed: ExcelExportView) => {
  const started = Date.now();
  const packageKey = claimed.packageKey;
  // progress for the run; a build that never starts keeps the claim's 0/0
  const report = progressReporter(claimed);

  try {
    const current = await excelWorkerDeps
      .read(claimed.id, claimed.organizationId, claimed.ownerUserId)
      .catch(() => null);

    // removed between claim and here: nothing to do
    if (!current) {
      await removePackage(packageKey);
      return;
    }
    if (current.status === "cancelling") {
      await excelWorkerDeps.move(claimed.id, "cancelling", { status: "cancelled" });
      emit(current, "modify");
      return;
    }

    // the card flips off Queued the moment work starts, before any phase
    emit(current, "modify");

    // one controller per run: a cancel stops the fetches, ffmpeg, and upload
    const controller = new AbortController();
    const built = await buildPackage(current, controller.signal, report);

    // a cancel that landed while the package was building still wins
    const beforeUpload = await excelWorkerDeps.read(
      claimed.id,
      current.organizationId,
      current.ownerUserId,
    );
    if (beforeUpload.status === "cancelling") {
      controller.abort();
      await excelWorkerDeps.move(claimed.id, "cancelling", {
        status: "cancelled",
        itemsTotal: report.resultCount(),
        itemsDone: report.resultCount(),
      });
      emit(beforeUpload, "modify");
      await removePackage(packageKey);
      return;
    }

    // the zip streams and uploads: an indeterminate last leg
    await report.packing();

    const bytes =
      built.kind === "xlsx"
        ? (await excelWorkerDeps.putObject(packageKey!, built.body), built.body.length)
        : (await excelWorkerDeps.package(packageKey!, built.entries, { signal: controller.signal }))
            .bytes;

    const status = built.errors.length > 0 ? "ready_with_errors" : "ready";
    const moved = await excelWorkerDeps.move(claimed.id, "running", {
      status,
      phase: "done",
      packageKey,
      packageSize: bytes,
      bytesWritten: bytes,
      // the finished row reads `N results`, not `N media files`
      itemsTotal: report.resultCount(),
      itemsDone: report.resultCount(),
      errors: built.errors.map((message) => ({ message })),
    });

    // the row left the table mid-run: the package has no owner
    if (!moved) {
      await removePackage(packageKey);
      return;
    }

    emit({ ...current, status }, "modify");
    log.info("excel export ready", {
      id: claimed.id,
      bytes,
      status,
      ms: Date.now() - started,
    });
  } catch (error) {
    const moved = await excelWorkerDeps.move(claimed.id, "running", {
      status: "failed",
      phase: "failed",
      itemsTotal: report.resultCount(),
      itemsDone: report.resultCount(),
      errors: [{ message: String(error) }],
    });
    if (!moved) {
      await removePackage(packageKey);
      return;
    }
    emit({ ...claimed, status: "failed" }, "modify");
    log.error("excel export failed", { id: claimed.id, err: String(error) });
  }
};

/* ---------- lanes ---------- */

let wake: () => void = () => {};
let woken = new Promise<void>((resolve) => {
  wake = resolve;
});

// Wakes every lane; a queue that arrived while a lane slept runs now.
export const kickExcelExportWorker = () => {
  const resolve = wake;
  woken = new Promise<void>((resolveNext) => {
    wake = resolveNext;
  });
  resolve();
};

const waitForWork = () => woken;

// One lane: claim while rows wait, sleep when the queue is empty.
const laneLoop = async (lane: (typeof LANES)[number]) => {
  for (;;) {
    try {
      const claimed = await excelWorkerDeps.claim(lane, packageKeyFor(lane, "xlsx"));
      if (!claimed) {
        await waitForWork();
        continue;
      }
      await runExcelExport(claimed);
    } catch (error) {
      log.error("excel export lane error", { lane, err: String(error) });
      await Bun.sleep(1_000);
    }
  }
};

// Retention: expired rows leave the listing, then their packages leave MinIO.
const sweep = async () => {
  try {
    const expired = await sweepExcelExports();
    for (const row of expired) await removePackage(row.packageKey);
    if (expired.length > 0) log.info("excel exports expired", { count: expired.length });
  } catch (error) {
    log.error("excel export sweep failed", { err: String(error) });
  }
};

// Boot: clear the scratch directory, then run both lanes.
export const startExcelExportWorker = async () => {
  await rm(env.EXCEL_EXPORT_SCRATCH_DIR, { recursive: true, force: true }).catch((error) => {
    log.warn("excel export scratch cleanup failed", { err: String(error) });
  });

  for (const lane of LANES) void laneLoop(lane);
  setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
};
