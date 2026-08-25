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
  // mint gate: only a finalized clip has playable objects behind its stem
  recordingStatus: string;
  // presigned mkv GET; null while unfinalized or finalization_failed
  videoUrl: string | null;
  startOffsetMs: number;
  endOffsetMs: number | null;
  durationMs: number | null;
  startEpochMs: number;
  endEpochMs: number | null;
};

export type ItemResultSidebarImage = {
  imageId: number;
  storageStem: string;
  contentType: string;
  // true when the annotated twin exists; reads pick the leaf without a probe
  hasAnnotated: boolean;
  remarks: string | null;
  // presigned GET (annotated leaf when it exists); minted per read, expires
  url: string;
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
  // first snip (lowest imageId) minted as the card poster
  posterUrl: string | null;
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

// evidence image write — contentType drives the stored extension.
// strict: an unknown key is a 400, matching the ingest create contract.
export const createResultImageSchema = z
  .object({
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    remarks: optionalText,
  })
  .strict();

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

/* ==========================================================
   inspections — typed detail payload union + lifecycle requests
   Payload shapes sourced from the app's
   task-tools/tools/<type>/*Types.ts; the CTI tables in
   src/db/schema.ts are the authority on nullability.
========================================================= */

export const mgiPayloadSchema = z.object({
  kind: z.literal("mgi"),
  version: z.literal(1),
  findings: z.array(
    z.object({
      id: z.string(),
      growthType: z.enum(["soft", "hard"]),
      species: z.string().min(1),
      speciesOtherText: z.string().nullish(),
      // slider-sourced: fractional values round at the integer column
      coveragePercent: z.number().min(0).max(100),
      thicknessMm: z.number(),
      remarks: z.string().nullish(),
    }),
  ),
  criteria: z.object({ preset: z.enum(["project_default", "client_cnc", "manual"]) }),
  noMgObserved: z.boolean(),
});

export const cpPayloadSchema = z.object({
  kind: z.literal("cp"),
  version: z.literal(1),
  anodeType: z.string().min(1),
  voltageMv: z.number(),
  depletion: z.string(),
  anodeWidth: z.number().nullish(),
  anodeHeight: z.number().nullish(),
  anodeLength: z.number().nullish(),
  widestPit: z.number().nullish(),
  deepestPit: z.number().nullish(),
});

const fmdAttemptValue = z.enum(["dry", "flooded", "na"]);

export const fmdPayloadSchema = z.object({
  kind: z.literal("fmd"),
  version: z.literal(1),
  depthEl: z.number().nullable(),
  initialAttempt: fmdAttemptValue,
  additionalAttempt1: fmdAttemptValue,
  additionalAttempt2: fmdAttemptValue,
  additionalAttempt3: fmdAttemptValue,
});

export const scourPayloadSchema = z.object({
  kind: z.literal("scour"),
  version: z.literal(1),
  exposedPile: z.enum(["exposed", "not_exposed"]),
  exposedPileHeight: z.number().nullable(),
  heightLeg1: z.number().nullable(),
  heightMidpoint: z.number().nullable(),
  heightLeg2: z.number().nullable(),
});

export const gviPayloadSchema = z.object({
  kind: z.literal("gvi"),
  version: z.literal(1),
  gviCP: z.number().nullish(),
  gviUT: z.number().nullish(),
  condition: z.enum(["ok", "not_ok"]),
});

export const cviPayloadSchema = z.object({
  kind: z.literal("cvi"),
  version: z.literal(1),
  datumReference: z.string().min(1),
  memberType: z.enum(["chord", "brace"]),
  positions: z.array(
    z.object({
      // the app's CLOCK_POSITIONS const
      clockPosition: z.enum(["12", "3", "6", "9"]),
      utMm: z.number().nullable(),
      findings: z.string(),
    }),
  ),
  cpPotentialMv: z.number().nullable(),
});

// one payload field, one union — never one API per inspection type
export const inspectionPayloadSchema = z.discriminatedUnion("kind", [
  mgiPayloadSchema,
  cpPayloadSchema,
  fmdPayloadSchema,
  scourPayloadSchema,
  gviPayloadSchema,
  cviPayloadSchema,
]);

export type InspectionPayload = z.infer<typeof inspectionPayloadSchema>;
export type MgiPayloadInput = z.infer<typeof mgiPayloadSchema>;
export type CpPayloadInput = z.infer<typeof cpPayloadSchema>;
export type FmdPayloadInput = z.infer<typeof fmdPayloadSchema>;
export type ScourPayloadInput = z.infer<typeof scourPayloadSchema>;
export type GviPayloadInput = z.infer<typeof gviPayloadSchema>;
export type CviPayloadInput = z.infer<typeof cviPayloadSchema>;

// inspection lifecycle requests
export const startInspectionSchema = z.object({
  sessionId: id,
  itemId: id,
  inspectionTypeCode: inspectionType,
  remarks: optionalText,
});

export const stopInspectionSchema = z.object({
  remarks: optionalText,
  payload: inspectionPayloadSchema,
});

export const activeInspectionQuerySchema = z.object({
  sessionId: queryId,
  itemId: queryId,
  inspectionTypeCode: inspectionType,
});
