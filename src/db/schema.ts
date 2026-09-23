import { pgTable, pgEnum, text, integer, bigint, boolean, doublePrecision, timestamp, uuid, date, primaryKey, index, unique, uniqueIndex, check, jsonb,} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* =================== CHANGABLE ENUMRATIONS =================== */

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

    // per-org ordinal, assigned max+1 at creation; the number a user reads and
    // the number every media key for this project carries
    displayNumber: integer("display_number").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxProjectTitle: index("idx_project_title").on(table.title),
    // split by org: unique indexes treat NULLs as distinct, so the org-null
    // rows (every project until better-auth lands) need their own guard
    uqProjectDisplayOrg: uniqueIndex("uq_project_display_org")
      .on(table.organizationId, table.displayNumber)
      .where(sql`${table.organizationId} IS NOT NULL`),
    uqProjectDisplayNoOrg: uniqueIndex("uq_project_display_noorg")
      .on(table.displayNumber)
      .where(sql`${table.organizationId} IS NULL`),
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
    displayNumber: integer("display_number").notNull(),
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
   TASK TREE (inspection structure)
   Task Group > Task Code > Main Component > Type > Component Code
========================================================= */
export const taskGroup = pgTable(
  "task_group",
  {
    taskGroupId: integer("task_group_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    groupCode: text("group_code").notNull(),
    label: text("label").notNull(),
    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxTaskGroupProjectId: index("idx_task_group_project_id").on(table.projectId),
    uqTaskGroupProjectCode: uniqueIndex("uq_task_group_project_code").on(
      table.projectId,
      table.groupCode
    ),
  })
);

export const taskCode = pgTable(
  "task_code",
  {
    taskCodeId: integer("task_code_id").primaryKey().generatedByDefaultAsIdentity(),

    taskGroupId: integer("task_group_id")
      .notNull()
      .references(() => taskGroup.taskGroupId, { onDelete: "cascade" }),

    code: text("code").notNull(),
    label: text("label").notNull(),
    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxTaskCodeTaskGroupId: index("idx_task_code_task_group_id").on(table.taskGroupId),
    uqTaskCodeGroupCode: uniqueIndex("uq_task_code_group_code").on(table.taskGroupId, table.code),
  })
);

export const mainComponent = pgTable(
  "main_component",
  {
    mainComponentId: integer("main_component_id").primaryKey().generatedByDefaultAsIdentity(),

    taskCodeId: integer("task_code_id")
      .notNull()
      .references(() => taskCode.taskCodeId, { onDelete: "cascade" }),

    // the "Description" field in the UI names the main component
    description: text("description").notNull(),
    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxMainComponentTaskCodeId: index("idx_main_component_task_code_id").on(table.taskCodeId),
    uqMainComponentTaskCodeDescription: uniqueIndex(
      "uq_main_component_task_code_description"
    ).on(table.taskCodeId, table.description),
  })
);

/* project-scoped reusable type catalog (VDM, VHM, Valve, ...);
   rename keeps the id so branches and results follow */
export const componentType = pgTable(
  "component_type",
  {
    componentTypeId: integer("component_type_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    typeCode: text("type_code").notNull(),
    label: text("label").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxComponentTypeProjectId: index("idx_component_type_project_id").on(table.projectId),
    uqComponentTypeProjectCode: uniqueIndex("uq_component_type_project_code").on(
      table.projectId,
      table.typeCode
    ),
  })
);

/* one type branch per main component; same type cannot repeat under one main component */
export const mainComponentType = pgTable(
  "main_component_type",
  {
    mainComponentTypeId: integer("main_component_type_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    mainComponentId: integer("main_component_id")
      .notNull()
      .references(() => mainComponent.mainComponentId, { onDelete: "cascade" }),

    // cascade: deleting a catalog value removes its branches (and their codes).
    // The "in use" refusal is a service-level 409, not a database block, so
    // deleting a project never deadlocks on cascade ordering.
    componentTypeId: integer("component_type_id")
      .notNull()
      .references(() => componentType.componentTypeId, { onDelete: "cascade" }),

    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxMainComponentTypeMainComponentId: index("idx_main_component_type_main_component_id").on(
      table.mainComponentId
    ),
    idxMainComponentTypeComponentTypeId: index(
      "idx_main_component_type_component_type_id"
    ).on(table.componentTypeId),
    uqMainComponentTypePair: uniqueIndex("uq_main_component_type_pair").on(
      table.mainComponentId,
      table.componentTypeId
    ),
  })
);

export const componentCode = pgTable(
  "component_code",
  {
    componentCodeId: integer("component_code_id").primaryKey().generatedByDefaultAsIdentity(),

    mainComponentTypeId: integer("main_component_type_id")
      .notNull()
      .references(() => mainComponentType.mainComponentTypeId, { onDelete: "cascade" }),

    code: text("code").notNull(),
    label: text("label"),
    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxComponentCodeMainComponentTypeId: index(
      "idx_component_code_main_component_type_id"
    ).on(table.mainComponentTypeId),
    uqComponentCodeBranchCode: uniqueIndex("uq_component_code_branch_code").on(
      table.mainComponentTypeId,
      table.code
    ),
  })
);

/* =========================================================
   INSPECTION FORM (versioned, per project per inspection type)
========================================================= */
export const inspectionForm = pgTable(
  "inspection_form",
  {
    inspectionFormId: integer("inspection_form_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    inspectionTypeCode: inspectionType("inspection_type_code").notNull(),
    version: integer("version").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxInspectionFormProjectId: index("idx_inspection_form_project_id").on(table.projectId),
    uqInspectionFormProjectTypeVersion: uniqueIndex(
      "uq_inspection_form_project_type_version"
    ).on(table.projectId, table.inspectionTypeCode, table.version),
  })
);

export const inspectionFormField = pgTable(
  "inspection_form_field",
  {
    inspectionFormFieldId: integer("inspection_form_field_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    inspectionFormId: integer("inspection_form_id")
      .notNull()
      .references(() => inspectionForm.inspectionFormId, { onDelete: "cascade" }),

    label: text("label").notNull(),
    // integer | decimal | text | boolean (check below)
    dataType: text("data_type").notNull(),
    required: boolean("required").notNull().default(false),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    displayOrder: integer("display_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxInspectionFormFieldFormId: index("idx_inspection_form_field_form_id").on(
      table.inspectionFormId
    ),
    uqInspectionFormFieldLabel: uniqueIndex("uq_inspection_form_field_label").on(
      table.inspectionFormId,
      table.label
    ),
    inspectionFormFieldDataTypeCheck: check(
      "inspection_form_field_data_type_check",
      sql`${table.dataType} IN ('integer', 'decimal', 'text', 'boolean')`,
    ),
  })
);

/* =========================================================
   RESULT (CORE FACT TABLE)
========================================================= */
export const result = pgTable(
  "result",
  {
    resultId: integer("result_id").primaryKey().generatedByDefaultAsIdentity(),

    inspectionTypeCode: inspectionType("inspection_type_code").notNull(),

    projectId: integer("project_id").notNull(),
    sessionId: integer("session_id").notNull(),

    // v2 target: main component XOR component code (check below).
    // cascade: removing a target removes its results.
    mainComponentId: integer("main_component_id").references(() => mainComponent.mainComponentId, {
      onDelete: "cascade",
    }),
    componentCodeId: integer("component_code_id").references(
      () => componentCode.componentCodeId,
      { onDelete: "cascade" }
    ),

    // master-video timeline anchors for playback layer markers
    masterStartMs: bigint("master_start_ms", { mode: "number" }),
    masterEndMs: bigint("master_end_ms", { mode: "number" }),

    // runtime stack layer 1-3 (check below); null on legacy rows
    layer: integer("layer"),

    // custom form values keyed by inspection_form_field id
    customValues: jsonb("custom_values"),

    // form version pinned at start; completed results keep their version
    inspectionFormId: integer("inspection_form_id").references(
      () => inspectionForm.inspectionFormId,
      { onDelete: "cascade" }
    ),

    // per-session ordinal, assigned max+1 at creation
    displayNumber: integer("display_number").notNull(),

    remarks: text("remarks"),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxResultProjectId: index("idx_result_project_id").on(table.projectId),
    idxResultSessionId: index("idx_result_session_id").on(table.sessionId),
    idxResultMainComponentId: index("idx_result_main_component_id").on(table.mainComponentId),
    idxResultComponentCodeId: index("idx_result_component_code_id").on(table.componentCodeId),
    // active-layer lookups: one open inspection per session per layer
    idxResultSessionLayer: index("idx_result_session_layer").on(table.sessionId, table.layer),
    // v2 target: exactly one target
    resultTargetCheck: check(
      "result_target_check",
      sql`num_nonnulls(${table.mainComponentId}, ${table.componentCodeId}) = 1`,
    ),
    resultLayerCheck: check(
      "result_layer_check",
      sql`${table.layer} IS NULL OR ${table.layer} BETWEEN 1 AND 3`,
    ),
    idxResultInspectionTypeCode: index("idx_result_inspection_type_code").on(
      table.inspectionTypeCode
    ),
    // per-session ordinal, assigned max+1 at creation. A clip is 1:1 with a
    // result, so one number names both the clip and the results folder.
    uqResultSessionDisplay: uniqueIndex("uq_result_session_display").on(
      table.sessionId,
      table.displayNumber
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

    startEpoch: bigint("start_epoch", { mode: "number" }).notNull(), // epoch SECONDS; bigint clears 2038
    endEpoch: bigint("end_epoch", { mode: "number" }),
    durationMs: integer("duration_ms"),
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
    // Object key of the clip's own card still; null until the still job runs.
    thumbnailKey: text("thumbnail_key"),
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
    // readable key directory, frozen at admission; every leaf hangs off it
    keyPrefix: text("key_prefix").notNull(),
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
