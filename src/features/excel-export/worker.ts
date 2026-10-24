// The export worker: one lane for workbooks, one for clip merges.
//
// Each lane claims the oldest queued row and runs it to a terminal status. A
// claim sets the package key before any upload, so a cancel or a crash knows
// what to remove. Every move is a compare-and-set; a write that matches no row
// means the export was removed meanwhile, and the package goes with it.
// flow: wake > claim > gather > build > upload > compare-and-set

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { publish } from "../../lib/events/bus";
import { minio } from "../../lib/minio_storage/clients";
import { parseDatasheetTargets } from "../../db/services/datasheet-data.service";
import { gatherExcelExport, type ExcelExportData } from "../../db/services/excel-export-data.service";
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
import { readmeEntry, writePackage, type PackageEntry } from "./package";
import { exportFilename, writeWorkbook, type MediaThumb } from "./workbook";

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

// Throttled progress, unthrottled terminal status.
const progressClock = new Map<string, number>();
export const emitProgress = (row: ExcelExportView) => {
  const last = progressClock.get(row.id) ?? 0;
  if (Date.now() - last < PROGRESS_INTERVAL_MS) return;
  progressClock.set(row.id, Date.now());
  emit(row, "modify");
};

// The seams the tests replace: the row store, the gather, and object storage.
export type ExcelWorkerDeps = {
  claim: typeof claimExcelExport;
  move: typeof moveExcelExport;
  read: (id: string, organizationId: number, ownerUserId: string) => Promise<ExcelExportView>;
  gather: typeof gatherExcelExport;
  build: typeof writeWorkbook;
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
  build: writeWorkbook,
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

// The README that ships before any media, naming the zip rules and the tools
// that open a ZIP64 archive.
const readmeLines = (row: ExcelExportView, files: number) => [
  "Travis excel export",
  "",
  `Project: ${row.projectId}`,
  `Results: ${row.itemsTotal}, media files: ${files}`,
  "",
  "Extract this zip before opening the workbook: image and clip links point to",
  "files beside it, and they break inside the archive.",
  "",
  "Windows Explorer and 7-Zip open this archive.",
  "macOS Archive Utility does not open a ZIP64 archive: use 7-Zip or Keka.",
];

// One entry per result. Flat rows repeat a result, so media fetches once.
export const resultTypesOf = (data: ExcelExportData) => {
  const seen = new Set<number>();
  const list: { resultId: number; type: InspectionTypeCode }[] = [];
  for (const sheet of data.sheets) {
    for (const row of sheet.rows) {
      if (seen.has(row.resultId)) continue;
      seen.add(row.resultId);
      list.push({ resultId: row.resultId, type: sheet.type });
    }
  }
  return list;
};

// flow: gather > (media: images > thumbnails) > workbook > zip entries
const buildPackage = async (row: ExcelExportView, signal: AbortSignal): Promise<BuiltPackage> => {
  const data = await excelWorkerDeps.gather(
    row.projectId,
    row.types as InspectionTypeCode[],
    parseDatasheetTargets(row.targets),
    row.organizationId,
  );

  if (row.media === "raw") {
    const body = await excelWorkerDeps.build(data, { mediaLevel: "raw" });
    return { kind: "xlsx", body, name: exportFilename(data.projectTitle, "raw"), errors: [] };
  }

  const scratch = path.join(env.EXCEL_EXPORT_SCRATCH_DIR, row.id);
  const resultTypes = resultTypesOf(data);

  const imagePlan =
    row.media === "images" || row.media === "clips"
      ? await collectImages(resultTypes, scratch, signal)
      : { files: [], rows: [], errors: [] };

  // clip merges run after the images, one at a time, inside the clips lane
  const clipPlan =
    row.media === "clips"
      ? await collectClips(resultTypes, scratch, signal)
      : { files: [], thumbs: new Map<number, MediaThumb>(), rows: [], errors: [] };

  const imageThumbs = new Map<number, MediaThumb[]>();
  for (const file of imagePlan.files) {
    const list = imageThumbs.get(file.resultId) ?? [];
    list.push({ thumbnail: file.thumbnail, target: file.target });
    imageThumbs.set(file.resultId, list);
  }

  const workbookBody = await excelWorkerDeps.build(data, {
    mediaLevel: row.media,
    mediaRows: [...imagePlan.rows, ...clipPlan.rows],
    imageThumbs,
    clipThumbs: clipPlan.thumbs,
  });

  // the workbook must be a stream like everything else, so it lands on disk
  await mkdir(scratch, { recursive: true });
  const workbookFile = path.join(scratch, "workbook.xlsx");
  await Bun.write(workbookFile, workbookBody);

  const mediaFiles = imagePlan.files.flatMap((file) => {
    const entries: PackageEntry[] = [
      { name: file.raw.name, open: () => Readable.from(Bun.file(file.raw.file).stream()) },
    ];
    const annotated = file.annotated;
    if (annotated) {
      entries.push({
        name: annotated.name,
        open: () => Readable.from(Bun.file(annotated.file).stream()),
      });
    }
    return entries;
  });

  // a merged clip streams out of scratch like an image does
  const clipFiles: PackageEntry[] = clipPlan.files.map((file) => ({
    name: file.name,
    open: () => Readable.from(Bun.file(file.file).stream()),
  }));

  const entries: PackageEntry[] = [
    readmeEntry(readmeLines(row, mediaFiles.length + clipFiles.length)),
    ...mediaFiles,
    ...clipFiles,
    { name: "workbook.xlsx", open: () => Readable.from(Bun.file(workbookFile).stream()) },
  ];

  // a missing image or clip is a delivered package with a stated gap
  return {
    kind: "zip",
    entries,
    name: exportFilename(data.projectTitle, row.media),
    errors: [...imagePlan.errors, ...clipPlan.errors],
  };
};

// Move one claimed row to a terminal status, or leave it cancelled.
export const runExcelExport = async (claimed: ExcelExportView) => {
  const started = Date.now();
  const packageKey = claimed.packageKey;

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

    // one controller per run: a cancel stops the fetches, ffmpeg, and upload
    const controller = new AbortController();
    const built = await buildPackage(current, controller.signal);
    progressClock.set(claimed.id, Date.now());

    // a cancel that landed while the package was building still wins
    const beforeUpload = await excelWorkerDeps.read(
      claimed.id,
      current.organizationId,
      current.ownerUserId,
    );
    if (beforeUpload.status === "cancelling") {
      controller.abort();
      await excelWorkerDeps.move(claimed.id, "cancelling", { status: "cancelled" });
      emit(beforeUpload, "modify");
      await removePackage(packageKey);
      return;
    }

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
      itemsDone: current.itemsTotal,
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
      errors: [{ message: String(error) }],
    });
    if (!moved) {
      await removePackage(packageKey);
      return;
    }
    emit({ ...claimed, status: "failed" }, "modify");
    log.error("excel export failed", { id: claimed.id, err: String(error) });
  } finally {
    progressClock.delete(claimed.id);
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
