// Mirror of the app's src/shared DTO contract (spec: one file, no redesign).
// Data types only — the app's renderer-side *Api interfaces stay app-side.
// Below the mirrors: zod request schemas (server-only vocabulary) that gate
// the SAME shapes at the REST boundary.
import { z } from "zod";

/* =========================================================
   structure (app: src/shared/structure.ts)
========================================================= */
export type ItemStatus = "not_set" | "pending" | "complete";

export type ProjectStructureItemNode = {
  itemId: number;
  componentId: number;
  itemLabel: string;
  position: string | null;
  status: ItemStatus | null;
};

export type CreateAssetInput = {
  projectId: number;
  name: string;
};

export type UpdateAssetInput = {
  name: string;
};

export type CreateComponentInput = {
  assetId: number;
  name: string;
};

export type UpdateComponentInput = {
  name: string;
};

export type CreateItemInput = {
  componentId: number;
  itemLabel: string;
  position?: string | null;
  status?: ItemStatus | null;
};

export type UpdateItemInput = {
  itemLabel?: string;
  position?: string | null;
  status?: ItemStatus | null;
};

export type AssetRecord = {
  assetId: number;
  projectId: number;
  name: string;
  assetType: string | null;
};

export type ComponentRecord = {
  componentId: number;
  assetId: number;
  projectId: number;
  name: string;
};

export type ItemRecord = {
  itemId: number;
  componentId: number;
  itemLabel: string;
  position: string | null;
  status: ItemStatus | null;
};

export type ProjectStructureComponentNode = {
  componentId: number;
  assetId: number;
  projectId: number;
  name: string;
  items: ProjectStructureItemNode[];
};

export type ProjectStructureAssetNode = {
  assetId: number;
  projectId: number;
  name: string;
  assetType: string | null;
  components: ProjectStructureComponentNode[];
};

/* =========================================================
   project (app: src/shared/project.ts)
========================================================= */
export type ProjectDashboardItem = {
  projectId: number;
  title: string;
  description: string | null;
  documentId: string | null;
  totalAssets: number;
  totalComponents: number;
  totalItems: number;
  completedItems: number;
  pendingItems: number;
  overallProgress: number;
};

export type CreateProjectInput = {
  title: string;
  description?: string | null;
  documentId?: string | null;
};

export type UpdateProjectInput = {
  title: string;
  description?: string | null;
  documentId?: string | null;
};

export type ProjectRecord = {
  projectId: number;
  title: string;
  description: string | null;
  documentId: string | null;
};

/* =========================================================
   result (app: src/shared/result.ts)
========================================================= */
export type InspectionTypeCode = "GVI" | "CVI" | "MGI" | "CP" | "FMD" | "SCOUR";

export type MgiDetail = {
  resultId: number;
  noMgObserved: number;
  criteriaPreset: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MgiFindingDetail = {
  findingId: number;
  resultMgiId: number;
  growthType: string | null;
  species: string;
  speciesOtherText: string | null;
  coveragePercent: number | null;
  thicknessMm: number | null;
  remarks: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CpDetail = {
  resultId: number;
  anodeType: string | null;
  voltageMv: number | null;
  depletion: string | null;
  anodeWidth: number | null;
  anodeHeight: number | null;
  anodeLength: number | null;
  widestPit: number | null;
  deepestPit: number | null;
  createdAt: string;
  updatedAt: string;
};

export type FmdDetail = {
  resultId: number;
  depthEl: number | null;
  initialAttempt: "dry" | "flooded" | "na";
  additionalAttempt1: "dry" | "flooded" | "na";
  additionalAttempt2: "dry" | "flooded" | "na";
  additionalAttempt3: "dry" | "flooded" | "na";
  createdAt: string;
  updatedAt: string;
};

export type ScourDetail = {
  resultId: number;
  exposedPile: "exposed" | "not_exposed";
  exposedPileHeight: number | null;
  heightLeg1: number | null;
  heightMidpoint: number | null;
  heightLeg2: number | null;
  createdAt: string;
  updatedAt: string;
};

export type GviDetail = {
  resultId: number;
  gviCP: number | null;
  gviUT: number | null;
  condition: "ok" | "not_ok";
  createdAt: string;
  updatedAt: string;
};

export type CviPositionDetail = {
  clockPosition: string;
  utMm: number | null;
  findings: string | null;
};

export type CviDetail = {
  resultId: number;
  datumReference: string | null;
  memberType: "chord" | "brace";
  positions: CviPositionDetail[];
  cpPotentialMv: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ItemResultSidebarClip = {
  clipId: number;
  resultId: number;
  storageStem: string | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
  durationMs: number | null;
  startEpochMs: number;
  endEpochMs: number | null;
};

export type ItemResultSidebarImage = {
  imageId: number;
  storageStem: string;
  remarks: string | null;
};

export type ItemResultSidebarEntry = {
  resultId: number;
  inspectionTypeCode: InspectionTypeCode;
  inspectionTypeName: string; // display-friendly (same as code in the app)
  projectId: number;
  assetId: number;
  componentId: number;
  itemId: number;
  sessionId: number;
  remarks: string | null;
  createdAt: string;
  updatedAt: string;
  images: ItemResultSidebarImage[];
  clips: ItemResultSidebarClip[];
};

export type ItemResultSidebarSession = {
  sessionId: number;
  sessionItemId: number;
  sessionName: string | null;
  results: ItemResultSidebarEntry[];
};

export type ItemResultSidebarData = {
  itemId: number;
  itemLabel: string;
  position: string | null;
  status: ItemStatus | null;
  sessions: ItemResultSidebarSession[];
};

export type ResultMgiWithFindings = {
  detail: {
    resultId: number;
    noMgObserved: number;
    criteriaPreset: string | null;
    createdAt: string;
    updatedAt: string;
  };
  findings: Array<{
    findingId: number;
    resultMgiId: number;
    growthType: string | null;
    species: string;
    speciesOtherText: string | null;
    coveragePercent: number | null;
    thicknessMm: number | null;
    remarks: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type ProjectRecordingListItem = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  storageStem: string | null;
  startEpoch: number; // epoch seconds, as stored
  endEpoch: number | null;
  recordingStatus: string;
  fileSize: number | null;
  durationMs: number | null;
};

export type ProjectResultSummaryRow = {
  resultId: number;
  createdAt: string;
  inspectionTypeCode: InspectionTypeCode;
  assetId: number;
  componentId: number;
  itemId: number;
  remarks: string | null;
  resultValue: string;
};

export type ResultSummaryDetail = {
  condition?: "ok" | "not_ok";
  memberType?: "chord" | "brace";
  datumReference?: string | null;
  cpPotentialMv?: number | null;
  exposedPile?: "exposed" | "not_exposed";
  voltageMv?: number | null;
  anodeType?: string | null;
  depletion?: string | null;
  anodeWidth?: number | null;
  anodeHeight?: number | null;
  anodeLength?: number | null;
  widestPit?: number | null;
  deepestPit?: number | null;
  initialAttempt?: "dry" | "flooded" | "na";
  noMgObserved?: number;
  findingCount?: number;
};

export type ResultEvidence = {
  clips: ItemResultSidebarClip[];
  images: ItemResultSidebarImage[];
};

/* =========================================================
   playbackWorkspace (app: src/shared/playbackWorkspace.ts)
========================================================= */
export type MasterVideoTimelineThumbnail = {
  thumbnailId: number;
  masterVideoId: number;
  timestampMs: number;
  storageStem: string;
  width: number;
  height: number;
  sizeBytes: number;
};

export type MasterVideoPlaybackEvent = {
  eventId: string;
  resultId: number;
  clipId: number;
  inspectionTypeCode: InspectionTypeCode;
  itemLabel: string;
  assetName: string;
  componentName: string;
  startOffsetMs: number;
  endOffsetMs: number | null;
  remarks: string | null;
  storageStem: string | null;
  images: ItemResultSidebarImage[];
  imageCount: number;
};

// session sibling of the opened master video (not a camera-angle source)
export type MasterVideoSessionRecording = {
  masterVideoId: number;
  storageStem: string | null;
  recordingStatus: string;
};

export type MasterVideoPlaybackData = {
  masterVideoId: number;
  sessionId: number;
  sessionName: string | null;
  storageStem: string | null;
  startEpoch: number;
  endEpoch: number | null;
  durationMs: number | null;
  recordingStatus: string;
  sessionRecordings: MasterVideoSessionRecording[];
  thumbnails: MasterVideoTimelineThumbnail[];
  events: MasterVideoPlaybackEvent[];
};

/* =========================================================
   report gather (server aggregate of the app's reportDataGatherer DB walk;
   canvas composition + image reads stay app-side)
========================================================= */
export type ReportContentSignature = {
  resultIds: number[];
  updatedAtByResultId: Record<number, string>;
  generatedAt: string;
};

export type ReportGatherResult = {
  result: ItemResultSidebarEntry;
  sessionName: string | null;
  typedDetail:
    | CpDetail
    | FmdDetail
    | ScourDetail
    | GviDetail
    | CviDetail
    | ResultMgiWithFindings
    | null;
};

export type ReportGatherItem = {
  itemId: number;
  itemLabel: string;
  position: string | null;
  assetName: string;
  componentName: string;
  results: ReportGatherResult[];
};

export type ReportGatherData = {
  project: ProjectRecord | null;
  items: ReportGatherItem[];
  signature: ReportContentSignature;
};

/* =========================================================
   request schemas (zod) — gate the mirrored inputs at /api/v1
========================================================= */

// body ids are JSON numbers; params/queries coerce from strings
const id = z.number().int().positive();
const optionalText = z.string().min(1).nullable().optional();
const itemStatus = z.enum(["not_set", "pending", "complete"]);
const inspectionType = z.enum(["GVI", "CVI", "MGI", "CP", "FMD", "SCOUR"]);

// projects — Create/UpdateProjectInput share one shape (title required)
export const projectInputSchema = z.object({
  title: z.string().min(1),
  description: optionalText,
  documentId: optionalText,
});

// structure
export const createAssetSchema = z.object({ projectId: id, name: z.string().min(1) });
export const updateAssetSchema = z.object({ name: z.string().min(1) });
export const createComponentSchema = z.object({ assetId: id, name: z.string().min(1) });
export const updateComponentSchema = z.object({ name: z.string().min(1) });
export const createItemSchema = z.object({
  componentId: id,
  itemLabel: z.string().min(1),
  position: optionalText,
  status: itemStatus.nullable().optional(),
});
// app parity: status null means "no change" -> strip to undefined
const itemStatusPatch = itemStatus
  .nullable()
  .optional()
  .transform((v) => (v === null ? undefined : v));
export const updateItemSchema = z.object({
  itemLabel: z.string().min(1).optional(),
  position: optionalText,
  status: itemStatusPatch,
});

// sessions — service normalize only honors name today
export const createSessionSchema = z.object({ projectId: id, name: optionalText });
export const updateSessionSchema = z.object({ name: optionalText });

// batch reads for the report gatherer
export const resultIdsSchema = z.object({ resultIds: z.array(id) });

// query params (string -> coerced)
const queryId = z.coerce.number().int().positive();
export const playbackQuerySchema = z.object({ projectId: queryId });
export const unfinishedRecordingsQuerySchema = z.object({
  projectId: queryId.optional(),
});
export const activeClipsQuerySchema = z.object({
  projectId: queryId.optional(),
  sessionId: queryId.optional(),
});
