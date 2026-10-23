// The export worker: one lane for workbooks, one for clip merges.
//
// Each lane claims the oldest queued row and runs it to a terminal status. A
// claim sets the package key before any upload, so a cancel or a crash knows
// what to remove. Every move is a compare-and-set; a write that matches no row
// means the export was removed meanwhile, and the package goes with it.
// flow: wake > claim > gather > build > upload > compare-and-set

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { env } from "../../config/env";
import { log } from "../../lib/logger";
import { publish } from "../../lib/events/bus";
import { minio } from "../../lib/minio_storage/clients";
import { parseDatasheetTargets } from "../../db/services/datasheet-data.service";
import { gatherExcelExport } from "../../db/services/excel-export-data.service";
import {
  claimExcelExport,
  getExcelExport,
  moveExcelExport,
  sweepExcelExports,
  type ExcelExportView,
} from "../../db/services/excel-export.service";
import type { InspectionTypeCode } from "../../types/api";
import { exportFilename, writeWorkbook } from "./workbook";

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

// The workbook for one row. Media levels land in later phases.
const buildPackage = async (row: ExcelExportView) => {
  if (row.media !== "raw") {
    // ponytail: images and clips arrive with their own phases; until then a
    // media export fails loudly instead of shipping a workbook that lies
    throw new Error(`media level ${row.media} is not available yet`);
  }

  const data = await excelWorkerDeps.gather(
    row.projectId,
    row.types as InspectionTypeCode[],
    parseDatasheetTargets(row.targets),
    row.organizationId,
  );

  const body = await excelWorkerDeps.build(data, { mediaLevel: row.media });
  return { body, name: exportFilename(data.projectTitle, row.media), extension: "xlsx" };
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

    const built = await buildPackage(current);
    progressClock.set(claimed.id, Date.now());

    // a cancel that landed while the workbook was building still wins
    const beforeUpload = await excelWorkerDeps.read(
      claimed.id,
      current.organizationId,
      current.ownerUserId,
    );
    if (beforeUpload.status === "cancelling") {
      await excelWorkerDeps.move(claimed.id, "cancelling", { status: "cancelled" });
      emit(beforeUpload, "modify");
      return;
    }

    await excelWorkerDeps.putObject(packageKey!, built.body);

    const moved = await excelWorkerDeps.move(claimed.id, "running", {
      status: "ready",
      phase: "done",
      packageKey,
      packageSize: built.body.length,
      bytesWritten: built.body.length,
      itemsDone: current.itemsTotal,
    });

    // the row left the table mid-run: the package has no owner
    if (!moved) {
      await removePackage(packageKey);
      return;
    }

    emit({ ...current, status: "ready" }, "modify");
    log.info("excel export ready", {
      id: claimed.id,
      bytes: built.body.length,
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
