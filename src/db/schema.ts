import { pgTable, pgEnum, text, integer, bigint, boolean, doublePrecision, timestamp, uuid, date, primaryKey, index, unique, uniqueIndex, check,} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* =================== CHANGABLE ENUMRATIONS =================== */
export const itemStatus = pgEnum("item_status", ["not_set", "pending", "complete"]);

export const inspectionType = pgEnum("inspection_type", ["GVI", "CVI", "MGI", "CP", "FMD", "SCOUR"]);

export const mgiCriteriaPreset = pgEnum("mgi_criteria_preset", [
  "project_default",
  "client_cnc",
  "manual",
]);

export const mgiGrowthType = pgEnum("mgi_growth_type", ["soft", "hard"]);

export const fmdAttempt = pgEnum("fmd_attempt", ["dry", "flooded", "na"]);

export const scourExposedPile = pgEnum("scour_exposed_pile", ["exposed", "not_exposed"]);

export const gviCondition = pgEnum("gvi_condition", ["ok", "not_ok"]);

export const cviMemberType = pgEnum("cvi_member_type", ["chord", "brace"]);

export const recordingStatus = pgEnum("recording_status", [
  "recording",
  "finalized",
  "interrupted",
  "finalization_failed",
  "canceled",
]);

/* =========================================================
   TIMESTAMPS (JS Date both sides; JSON gives ISO strings)
========================================================= */
const createdAt = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

const updatedAt = {
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

const archivedAt = {
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
};

/* =========================================================
   ORGANIZATION (tenancy prep — seeded at boot, NOT NULL later)
========================================================= */
export const organization = pgTable("organization", {
  organizationId: integer("organization_id").primaryKey().generatedByDefaultAsIdentity(),
  name: text("name").notNull().unique(),

  ...createdAt,
  ...updatedAt,
});

/* =========================================================
   PROJECT
========================================================= */
export const project = pgTable(
  "project",
  {
    projectId: integer("project_id").primaryKey().generatedByDefaultAsIdentity(),
    title: text("title").notNull(),
    description: text("description"),
    documentId: text("document_id"),

    // nullable until better-auth lands, then NOT NULL
    organizationId: integer("organization_id").references(() => organization.organizationId),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxProjectTitle: index("idx_project_title").on(table.title),
  })
);

/* =========================================================
   SESSION (WORK RUN)
========================================================= */
export const session = pgTable(
  "session",
  {
    sessionId: integer("session_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    name: text("name"),
    displayNumber: integer("display_number"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxSessionProjectId: index("idx_session_project_id").on(table.projectId),
    uniqSessionProjectDisplay: uniqueIndex("uniq_session_project_display").on(
      table.projectId,
      table.displayNumber,
    ),
  })
);

/* =========================================================
   ASSET
========================================================= */
export const asset = pgTable(
  "asset",
  {
    assetId: integer("asset_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    name: text("name").notNull(),
    assetType: text("asset_type"),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxAssetProjectId: index("idx_asset_project_id").on(table.projectId),
  })
);

/* =========================================================
   COMPONENT
========================================================= */
export const component = pgTable(
  "component",
  {
    componentId: integer("component_id").primaryKey().generatedByDefaultAsIdentity(),

    assetId: integer("asset_id")
      .notNull()
      .references(() => asset.assetId, { onDelete: "cascade" }),

    projectId: integer("project_id").notNull(), // denormalized, indexed, NOT a FK

    name: text("name").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxComponentAssetId: index("idx_component_asset_id").on(table.assetId),
    idxComponentProjectId: index("idx_component_project_id").on(table.projectId),
  })
);

/* =========================================================
   ITEM
========================================================= */
export const item = pgTable(
  "item",
  {
    itemId: integer("item_id").primaryKey().generatedByDefaultAsIdentity(),

    componentId: integer("component_id")
      .notNull()
      .references(() => component.componentId, { onDelete: "cascade" }),

    projectId: integer("project_id").notNull(), // denormalized, indexed, NOT a FK
    assetId: integer("asset_id").notNull(), // denormalized, indexed, NOT a FK

    itemLabel: text("item_label").notNull(),

    position: text("position"),
    status: itemStatus("status").notNull().default("not_set"),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    itemLabelWithinComponent: unique("item_label_within_component").on(
      table.componentId,
      table.itemLabel
    ),
    idxItemComponentId: index("idx_item_component_id").on(table.componentId),
    idxItemProjectId: index("idx_item_project_id").on(table.projectId),
    idxItemAssetId: index("idx_item_asset_id").on(table.assetId),
  })
);

/* =========================================================
   SESSION ITEM (SESSION ↔ ITEM)
========================================================= */
export const sessionItem = pgTable(
  "session_item",
  {
    sessionItemId: integer("session_item_id").primaryKey().generatedByDefaultAsIdentity(),

    sessionId: integer("session_id")
      .notNull()
      .references(() => session.sessionId, { onDelete: "cascade" }),

    itemId: integer("item_id")
      .notNull()
      .references(() => item.itemId, { onDelete: "cascade" }),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    sessionItemUnique: unique("session_item_session_id_item_id_unique").on(
      table.sessionId,
      table.itemId
    ),
    idxSessionItemSessionId: index("idx_session_item_session_id").on(table.sessionId),
    idxSessionItemItemId: index("idx_session_item_item_id").on(table.itemId),
  })
);

/* =========================================================
   RESULT (CORE FACT TABLE)
========================================================= */
export const result = pgTable(
  "result",
  {
    resultId: integer("result_id").primaryKey().generatedByDefaultAsIdentity(),

    sessionItemId: integer("session_item_id")
      .notNull()
      .references(() => sessionItem.sessionItemId, { onDelete: "cascade" }),

    inspectionTypeCode: inspectionType("inspection_type_code").notNull(),

    // denormalized hierarchy ids (indexed ints, NOT FKs) — query perf + mediaEngine paths
    projectId: integer("project_id").notNull(),
    assetId: integer("asset_id").notNull(),
    componentId: integer("component_id").notNull(),
    itemId: integer("item_id").notNull(),
    sessionId: integer("session_id").notNull(),

    remarks: text("remarks"),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxResultSessionItemId: index("idx_result_session_item_id").on(table.sessionItemId),
    idxResultProjectId: index("idx_result_project_id").on(table.projectId),
    idxResultAssetId: index("idx_result_asset_id").on(table.assetId),
    idxResultComponentId: index("idx_result_component_id").on(table.componentId),
    idxResultItemId: index("idx_result_item_id").on(table.itemId),
    idxResultSessionId: index("idx_result_session_id").on(table.sessionId),
    idxResultInspectionTypeCode: index("idx_result_inspection_type_code").on(
      table.inspectionTypeCode
    ),
  })
);

/* =========================================================
   TYPED DETAIL TABLES (CTI - Class Table Inheritance)
   ========================================================= */

/* ---------------------------------------------------------
   MGI — Marine Growth Inspection
--------------------------------------------------------- */
export const resultMgi = pgTable(
  "result_mgi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),

    // plain 0/1 int end-to-end — boolean would break the DTO contract
    noMgObserved: integer("no_mg_observed")
      .notNull()
      .default(0),
    criteriaPreset: mgiCriteriaPreset("criteria_preset"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    resultMgiNoMgObservedCheck: check(
      "result_mgi_no_mg_observed_check",
      sql`${table.noMgObserved} IN (0, 1)`,
    ),
  })
);

export const resultMgiFinding = pgTable(
  "result_mgi_finding",
  {
    findingId: integer("finding_id").primaryKey().generatedByDefaultAsIdentity(),

    resultMgiId: integer("result_mgi_id")
      .notNull()
      .references(() => resultMgi.resultId, { onDelete: "cascade" }),

    growthType: mgiGrowthType("growth_type"),
    species: text("species").notNull(),
    speciesOtherText: text("species_other_text"),
    coveragePercent: integer("coverage_percent"),
    thicknessMm: integer("thickness_mm"),
    remarks: text("remarks"),
    sortOrder: integer("sort_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultMgiFindingMgi: index("idx_result_mgi_finding_mgi").on(table.resultMgiId),
  })
);

/* ---------------------------------------------------------
   CP — Cathodic Protection
--------------------------------------------------------- */
export const resultCp = pgTable("result_cp", {
  resultId: integer("result_id")
    .primaryKey()
    .references(() => result.resultId, { onDelete: "cascade" }),
  anodeType: text("anodeType"), // camelCase column name kept verbatim
  voltageMv: integer("voltage_mv"),
  depletion: text("depletion"),
  anodeWidth: integer("anodeWidth"),
  anodeHeight: integer("anodeHeight"),
  anodeLength: integer("anodeLength"),
  widestPit: integer("widestPit"),
  deepestPit: integer("deepestPit"),

  ...createdAt,
  ...updatedAt,
});

/* ---------------------------------------------------------
   FMD — Flooded Member Detection
--------------------------------------------------------- */
export const resultFmd = pgTable(
  "result_fmd",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),
    depthEl: doublePrecision("depth_el"),
    initialAttempt: fmdAttempt("initialAttempt").notNull(),
    additionalAttempt1: fmdAttempt("additionalAttempt1").notNull(),
    additionalAttempt2: fmdAttempt("additionalAttempt2").notNull(),
    additionalAttempt3: fmdAttempt("additionalAttempt3").notNull(),

    ...createdAt,
    ...updatedAt,
  }
);

/* ---------------------------------------------------------
   SCOUR — Scour Inspection
--------------------------------------------------------- */
export const resultScour = pgTable(
  "result_scour",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),
    exposedPile: scourExposedPile("exposed_pile").notNull(),
    exposedPileHeight: doublePrecision("exposed_pile_height"),
    heightLeg1: doublePrecision("height_leg1"),
    heightMidpoint: doublePrecision("height_midpoint"),
    heightLeg2: doublePrecision("height_leg2"),

    ...createdAt,
    ...updatedAt,
  }
);

/* ---------------------------------------------------------
   GVI — General Visual Inspection
--------------------------------------------------------- */
export const resultGvi = pgTable(
  "result_gvi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),
    gviCP: integer("gvi_cp"),
    gviUT: integer("gvi_ut"),
    condition: gviCondition("condition").notNull(),

    ...createdAt,
    ...updatedAt,
  }
);

/* ---------------------------------------------------------
   CVI — Close Visual Inspection
--------------------------------------------------------- */
export const resultCvi = pgTable(
  "result_cvi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),
    datumReference: text("datum_reference"),
    memberType: cviMemberType("member_type").notNull(),
    cpPotentialMv: integer("cp_potential_mv"),

    ...createdAt,
    ...updatedAt,
  }
);

export const resultCviPosition = pgTable(
  "result_cvi_position",
  {
    positionId: integer("position_id").primaryKey().generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => resultCvi.resultId, { onDelete: "cascade" }),

    clockPosition: text("clock_position").notNull(),
    utMm: doublePrecision("ut_mm"),
    findings: text("findings"),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultCviPositionResultId: index("idx_result_cvi_position_result_id").on(table.resultId),
  })
);

/* =========================================================
   MASTER VIDEO (SESSION RECORDING)
========================================================= */
export const masterVideo = pgTable(
  "master_video",
  {
    masterVideoId: integer("master_video_id").primaryKey().generatedByDefaultAsIdentity(),

    sessionId: integer("session_id")
      .notNull()
      .references(() => session.sessionId, { onDelete: "cascade" }),

    // nullable by design: the stem embeds the row's own PK, so ingest inserts
    // and sets it in the same transaction (insert > returning > update)
    storageStem: text("storage_stem"),

    startEpoch: bigint("start_epoch", { mode: "number" }).notNull(), // epoch SECONDS; bigint clears 2038
    endEpoch: bigint("end_epoch", { mode: "number" }),
    recordingStatus: recordingStatus("recording_status").notNull().default("finalized"),
    durationMs: integer("duration_ms"),
    fileSize: bigint("file_size", { mode: "number" }), // bigint: long takes pass 2 GB
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    idxMasterVideoSessionId: index("idx_master_video_session_id").on(table.sessionId),
  })
);

/* =========================================================
   TIMELINE THUMBNAIL
========================================================= */
export const timelineThumbnail = pgTable(
  "timeline_thumbnail",
  {
    thumbnailId: integer("thumbnail_id").primaryKey().generatedByDefaultAsIdentity(),

    masterVideoId: integer("master_video_id")
      .notNull()
      .references(() => masterVideo.masterVideoId, { onDelete: "cascade" }),

    timestampMs: integer("timestamp_ms").notNull(),
    storageStem: text("storage_stem").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: integer("size_bytes").notNull(),

    ...createdAt,
  },
  (table) => ({
    // composite: filmstrip reads walk one master in time order
    idxTimelineThumbnailMasterVideoTs: index("idx_timeline_thumbnail_master_video_ts").on(
      table.masterVideoId,
      table.timestampMs,
    ),
  })
);

/* =========================================================
   VIDEO CLIP (RESULT-BASED EVIDENCE)
========================================================= */
export const videoClip = pgTable(
  "video_clip",
  {
    clipId: integer("clip_id").primaryKey().generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => result.resultId, { onDelete: "cascade" }),

    // intentionally NO cascade — clips survive master deletion
    masterVideoId: integer("master_video_id")
      .notNull()
      .references(() => masterVideo.masterVideoId),

    startOffsetMs: integer("start_offset_ms").notNull(),
    endOffsetMs: integer("end_offset_ms"),
    // nullable by design: same PK-embedded-stem insert flow as master_video
    storageStem: text("storage_stem"),
    recordingStatus: recordingStatus("recording_status").notNull().default("finalized"),
    fileSize: bigint("file_size", { mode: "number" }), // bigint: long takes pass 2 GB
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // one clip per inspection instance — the app enforced this in code only
    uqVideoClipResultId: uniqueIndex("uq_video_clip_result_id").on(table.resultId),
    idxVideoClipMasterVideoId: index("idx_video_clip_master_video_id").on(table.masterVideoId),
  })
);

/* =========================================================
   RESULT IMAGE
========================================================= */
export const resultImage = pgTable(
  "result_image",
  {
    imageId: integer("image_id").primaryKey().generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => result.resultId, { onDelete: "cascade" }),

    // required: the result row knows its stem at insert time (result stem
    // derives from resultId, not from this row's own PK)
    storageStem: text("storage_stem").notNull(),

    // upload format — leaf extension derives from this, never hardcoded
    contentType: text("content_type").notNull().default("image/png"),

    // true once the annotated twin is written; reads skip a storage probe
    hasAnnotated: boolean("has_annotated").notNull().default(false),
    remarks: text("remarks"),
  },
  (table) => ({
    idxResultImageResultId: index("idx_result_image_result_id").on(table.resultId),
  })
);

/* =========================================================
   RECORDING UPLOAD V2 (protocol 2)
   Durable upload ledger — replaces the SQLite tracker for
   v2. Legacy routes keep their SQLite tracker until cutover.
   Upload rows outlive domain rows: FKs are NO ACTION on
   purpose, so domain deletion can never cascade here.
========================================================= */
export const recordingUploadKind = pgEnum("recording_upload_kind", ["master", "clip"]);

export const recordingCaptureState = pgEnum("recording_capture_state", [
  "recording",
  "stopped",
  "interrupted",
]);

export const recordingSegmentReceiptState = pgEnum("recording_segment_receipt_state", [
  "reserved",
  "stored",
]);

export const recordingJobState = pgEnum("recording_job_state", [
  "pending",
  "running",
  "completed",
  "failed",
]);

/* ---------------------------------------------------------
   One row per recording attempt, keyed by the app's UUID.
--------------------------------------------------------- */
export const recordingUpload = pgTable(
  "recording_upload",
  {
    recordingId: uuid("recording_id").primaryKey(),
    protocolVersion: integer("protocol_version").notNull(),
    backendInstanceId: uuid("backend_instance_id").notNull(),
    // hash of the immutable admission body — same UUID + other hash = 409
    admissionHash: text("admission_hash").notNull(),
    kind: recordingUploadKind("kind").notNull(),
    masterVideoId: integer("master_video_id").references(() => masterVideo.masterVideoId),
    clipId: integer("clip_id").references(() => videoClip.clipId),
    // immutable MinIO key prefix, e.g. recordings/<recordingId>/segments
    objectPrefix: text("object_prefix").notNull(),
    captureState: recordingCaptureState("capture_state").notNull().default("recording"),
    finalSegmentIndex: integer("final_segment_index"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true, mode: "date" }),
    // bumped only when a new stored receipt commits
    segmentRevision: integer("segment_revision").notNull().default(0),
    publishedRevision: integer("published_revision"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    // exactly one domain FK per kind
    recordingUploadKindTargetCheck: check(
      "recording_upload_kind_target_check",
      sql`(${table.kind} = 'master' AND ${table.masterVideoId} IS NOT NULL AND ${table.clipId} IS NULL)
       OR (${table.kind} = 'clip' AND ${table.clipId} IS NOT NULL)`,
    ),
    idxRecordingUploadBackendInstanceId: index("idx_recording_upload_backend_instance_id").on(
      table.backendInstanceId
    ),
    idxRecordingUploadCaptureState: index("idx_recording_upload_capture_state").on(
      table.captureState
    ),
  })
);

/* ---------------------------------------------------------
   Segment reservation/receipt ledger — composite PK with
   recording. expected* are checked again at completion.
--------------------------------------------------------- */
export const recordingSegment = pgTable(
  "recording_segment",
  {
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordingUpload.recordingId),
    segmentIndex: integer("segment_index").notNull(),
    expectedChecksum: text("expected_checksum").notNull(), // sha-256 hex
    expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    receiptState: recordingSegmentReceiptState("receipt_state").notNull().default("reserved"),
    storedAt: timestamp("stored_at", { withTimezone: true, mode: "date" }),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    recordingSegmentPk: primaryKey({ columns: [table.recordingId, table.segmentIndex] }),
    idxRecordingSegmentState: index("idx_recording_segment_state").on(table.receiptState),
  })
);

/* ---------------------------------------------------------
   Revision-aware finalization work. Unique on recording/
   revision; claims use leases (worker wiring lands later).
--------------------------------------------------------- */
export const recordingFinalizeJob = pgTable(
  "recording_finalize_job",
  {
    jobId: uuid("job_id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordingUpload.recordingId),
    targetRevision: integer("target_revision").notNull(),
    state: recordingJobState("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    leaseOwnerId: text("lease_owner_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    uqRecordingFinalizeJobRecordingRevision: unique(
      "uq_recording_finalize_job_recording_revision"
    ).on(table.recordingId, table.targetRevision),
    idxRecordingFinalizeJobClaim: index("idx_recording_finalize_job_claim").on(
      table.state,
      table.nextAttemptAt
    ),
  })
);

/* ---------------------------------------------------------
   Deployment identity singleton (row id locked to 1) —
   stable backendInstanceId + recovery-authority flag.
--------------------------------------------------------- */
export const backendIdentity = pgTable(
  "backend_identity",
  {
    singletonId: integer("singleton_id").primaryKey(),
    instanceId: uuid("instance_id").notNull().defaultRandom(),
    recoveryAuthorityEnabled: boolean("recovery_authority_enabled").notNull().default(false),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    backendIdentitySingletonCheck: check(
      "backend_identity_singleton_check",
      sql`${table.singletonId} = 1`
    ),
  })
);

/* ---------------------------------------------------------
   Audit trail for audited unknown-recording discards. No
   FK on recordingId — the discarded UUID may have no row.
--------------------------------------------------------- */
export const recordingDiscardAudit = pgTable(
  "recording_discard_audit",
  {
    discardId: uuid("discard_id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    recordingId: uuid("recording_id").notNull(),
    backendInstanceId: uuid("backend_instance_id").notNull(),
    reason: text("reason").notNull(),

    ...createdAt,
  },
  (table) => ({
    uqRecordingDiscardAuditRequestRecording: unique(
      "uq_recording_discard_audit_request_recording"
    ).on(table.requestId, table.recordingId),
  })
);

/* =========================================================
   RECORDING INGEST (direct protocol)
   Backend-owned identity: a numeric ingestId plus a hashed
   bearer ticket. No client UUID, no nonce, no raw ticket.
========================================================= */
export const recordingIngestKind = pgEnum("recording_ingest_kind", ["master", "clip"]);

/* ---------------------------------------------------------
   One row per capture attempt. The row carries the contiguous
   pointer and the close facts, so segment commit and close can
   serialize on it.
--------------------------------------------------------- */
export const recordingIngest = pgTable(
  "recording_ingest",
  {
    ingestId: integer("ingest_id").primaryKey().generatedByDefaultAsIdentity(),
    kind: recordingIngestKind("kind").notNull(),
    // exactly one target per kind (check below); cascade: the ingest is
    // transport metadata and dies with the domain row it feeds
    masterVideoId: integer("master_video_id").references(() => masterVideo.masterVideoId, {
      onDelete: "cascade",
    }),
    clipId: integer("clip_id").references(() => videoClip.clipId, { onDelete: "cascade" }),
    // sha-256 hex of the bearer ticket; the raw ticket never reaches the database
    ticketHash: text("ticket_hash").notNull(),
    // recording start UTC, frozen at admission: a midnight rollover never moves keys
    keyDate: date("key_date", { mode: "string" }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // null until the first committed segment; the sweep falls back to openedAt
    lastSegmentAt: timestamp("last_segment_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    // last sequence of the contiguous prefix, -1 while the prefix is empty
    contiguousSequence: integer("contiguous_sequence").notNull().default(-1),
    // frozen at close; playable range never passes it
    finalSequence: integer("final_sequence"),
    durationMs: integer("duration_ms"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    recordingIngestKindTargetCheck: check(
      "recording_ingest_kind_target_check",
      sql`(${table.kind} = 'master' AND ${table.masterVideoId} IS NOT NULL AND ${table.clipId} IS NULL)
       OR (${table.kind} = 'clip' AND ${table.clipId} IS NOT NULL AND ${table.masterVideoId} IS NULL)`,
    ),
    // one open ingest per clip: admission of a second is a 409, enforced here
    uqRecordingIngestOpenClip: uniqueIndex("uq_recording_ingest_open_clip")
      .on(table.clipId)
      .where(sql`${table.closedAt} IS NULL AND ${table.kind} = 'clip'`),
    idxRecordingIngestOpen: index("idx_recording_ingest_open").on(table.closedAt),
  })
);

/* ---------------------------------------------------------
   One stored TS object per row. Composite PK (ingest, sequence)
   makes a replay hit the same row instead of a duplicate.
--------------------------------------------------------- */
export const recordingIngestSegment = pgTable(
  "recording_ingest_segment",
  {
    ingestId: integer("ingest_id")
      .notNull()
      .references(() => recordingIngest.ingestId, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // measured on the client, never derived from the 2 s splitmuxsink target
    durationMs: integer("duration_ms").notNull(),
    discontinuity: boolean("discontinuity").notNull().default(false),
    objectKey: text("object_key").notNull(),
    storedAt: timestamp("stored_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),

    ...createdAt,
  },
  (table) => ({
    recordingIngestSegmentPk: primaryKey({ columns: [table.ingestId, table.sequence] }),
  })
);
