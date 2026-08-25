import { pgTable, pgEnum, text, integer, bigint, boolean, doublePrecision, timestamp, index, unique, uniqueIndex, check,} from "drizzle-orm/pg-core";
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
    remarks: text("remarks"),
  },
  (table) => ({
    idxResultImageResultId: index("idx_result_image_result_id").on(table.resultId),
  })
);
