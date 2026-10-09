import { pgTable, pgEnum, text, integer, bigint, boolean, doublePrecision, timestamp, uuid, date, primaryKey, index, unique, uniqueIndex, check, jsonb,} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* =================== ENUMERATIONS =================== */

export const inspectionType = pgEnum("inspection_type", ["GVI", "CVI", "DVI", "MGI", "CP", "FMD", "SCOUR", "BSI", "CAISSON", "RA"]);

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

export const dviMemberType = pgEnum("dvi_member_type", ["chord", "brace"]);

export const bsiGapCondition = pgEnum("bsi_gap_condition", ["gap", "no_gap"]);

export const bsiAlignmentCondition = pgEnum("bsi_alignment_condition", ["aligned", "misaligned"]);

export const bsiMisalignedPosition = pgEnum("bsi_misaligned_position", ["top", "mid", "bottom"]);

export const cgbYesNo = pgEnum("cgb_yes_no", ["yes", "no"]);

/* =========================================================
   TIMESTAMPS
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
   ORGANIZATION
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

    // per-org ordinal; also keys every media object for this project
    displayNumber: integer("display_number").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxProjectTitle: index("idx_project_title").on(table.title),
    uqProjectDisplayOrg: uniqueIndex("uq_project_display_org")
      .on(table.organizationId, table.displayNumber)
      .where(sql`${table.organizationId} IS NOT NULL`),
    uqProjectDisplayNoOrg: uniqueIndex("uq_project_display_noorg")
      .on(table.displayNumber)
      .where(sql`${table.organizationId} IS NULL`),
  })
);

/* =========================================================
   SESSION (each session IS the master recording)
   start_epoch / end_epoch / duration_ms replace master_video.
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

    // master recording anchors (epoch SECONDS; bigint clears 2038)
    startEpoch: bigint("start_epoch", { mode: "number" }),
    endEpoch: bigint("end_epoch", { mode: "number" }),
    durationMs: integer("duration_ms"),
    recordingUpdatedAt: timestamp("recording_updated_at", { withTimezone: true, mode: "date" }),

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
   TASK TREE
   task_group → task_code → description → type → part_code
========================================================= */
export const taskGroup = pgTable(
  "task_group",
  {
    taskGroupId: integer("task_group_id").primaryKey().generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    code: text("code").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxTaskGroupProjectId: index("idx_task_group_project_id").on(table.projectId),
    uqTaskGroupProjectCode: uniqueIndex("uq_task_group_project_code").on(
      table.projectId,
      table.code
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

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxTaskCodeTaskGroupId: index("idx_task_code_task_group_id").on(table.taskGroupId),
    uqTaskCodeGroupCode: uniqueIndex("uq_task_code_group_code").on(table.taskGroupId, table.code),
  })
);

/* the UI "Description" field — the named structural component */
export const description = pgTable(
  "description",
  {
    descriptionId: integer("description_id").primaryKey().generatedByDefaultAsIdentity(),

    taskCodeId: integer("task_code_id")
      .notNull()
      .references(() => taskCode.taskCodeId, { onDelete: "cascade" }),

    label: text("label").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxDescriptionTaskCodeId: index("idx_description_task_code_id").on(table.taskCodeId),
    uqDescriptionTaskCodeLabel: uniqueIndex("uq_description_task_code_label").on(
      table.taskCodeId,
      table.label
    ),
  })
);

/* component type — owned by one description, not a shared catalog */
export const type = pgTable(
  "type",
  {
    typeId: integer("type_id").primaryKey().generatedByDefaultAsIdentity(),

    descriptionId: integer("description_id")
      .notNull()
      .references(() => description.descriptionId, { onDelete: "cascade" }),

    code: text("code").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxTypeDescriptionId: index("idx_type_description_id").on(table.descriptionId),
    uqTypeDescriptionCode: uniqueIndex("uq_type_description_code").on(
      table.descriptionId,
      table.code
    ),
  })
);

export const partCode = pgTable(
  "part_code",
  {
    partCodeId: integer("part_code_id").primaryKey().generatedByDefaultAsIdentity(),

    typeId: integer("type_id")
      .notNull()
      .references(() => type.typeId, { onDelete: "cascade" }),

    code: text("code").notNull(),

    ...createdAt,
    ...updatedAt,
    ...archivedAt,
  },
  (table) => ({
    idxPartCodeTypeId: index("idx_part_code_type_id").on(table.typeId),
    uqPartCodeTypeCode: uniqueIndex("uq_part_code_type_code").on(table.typeId, table.code),
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
    // integer | decimal | text | boolean
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
   PLANNED INSPECTION (preassigned task, before any session)
========================================================= */
export const plannedInspection = pgTable(
  "planned_inspection",
  {
    plannedInspectionId: integer("planned_inspection_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    projectId: integer("project_id")
      .notNull()
      .references(() => project.projectId, { onDelete: "cascade" }),

    // target: description XOR part_code (check below), same shape as result
    descriptionId: integer("description_id").references(() => description.descriptionId, {
      onDelete: "cascade",
    }),
    partCodeId: integer("part_code_id").references(() => partCode.partCodeId, {
      onDelete: "cascade",
    }),

    inspectionTypeCode: inspectionType("inspection_type_code").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxPlannedInspectionProjectId: index("idx_planned_inspection_project_id").on(
      table.projectId
    ),
    // one planned type per target; NULLS NOT DISTINCT so the nullable half of
    // the XOR target cannot slip duplicates past the constraint
    uqPlannedInspectionTarget: unique("uq_planned_inspection_target")
      .on(
        table.projectId,
        table.descriptionId,
        table.partCodeId,
        table.inspectionTypeCode
      )
      .nullsNotDistinct(),
    plannedInspectionTargetCheck: check(
      "planned_inspection_target_check",
      sql`num_nonnulls(${table.descriptionId}, ${table.partCodeId}) = 1`,
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
    // null on RA rows only; a restricted-access mark has no session
    sessionId: integer("session_id"),

    // mirrors type = 'RA' for the unique indexes below: a partial index
    // predicate cannot use an enum value added in the same migration txn
    isRa: boolean("is_ra").notNull().default(false),

    // target: description XOR part_code (check below)
    descriptionId: integer("description_id").references(() => description.descriptionId, {
      onDelete: "cascade",
    }),
    partCodeId: integer("part_code_id").references(() => partCode.partCodeId, {
      onDelete: "cascade",
    }),

    // master timeline anchors for playback layer markers
    masterStartMs: bigint("master_start_ms", { mode: "number" }),
    masterEndMs: bigint("master_end_ms", { mode: "number" }),

    // runtime stack layer 1-2; null on legacy rows
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
    idxResultDescriptionId: index("idx_result_description_id").on(table.descriptionId),
    idxResultPartCodeId: index("idx_result_part_code_id").on(table.partCodeId),
    idxResultSessionLayer: index("idx_result_session_layer").on(table.sessionId, table.layer),
    idxResultInspectionTypeCode: index("idx_result_inspection_type_code").on(
      table.inspectionTypeCode
    ),
    resultTargetCheck: check(
      "result_target_check",
      sql`num_nonnulls(${table.descriptionId}, ${table.partCodeId}) = 1`,
    ),
    resultLayerCheck: check(
      "result_layer_check",
      sql`${table.layer} IS NULL OR ${table.layer} BETWEEN 1 AND 2`,
    ),
    uqResultSessionDisplay: uniqueIndex("uq_result_session_display").on(
      table.sessionId,
      table.displayNumber
    ),
    // one RA row per target, split by target kind: the XOR check makes exactly
    // one branch reachable per row, so plain NULL semantics stay correct
    uqResultRaDescription: uniqueIndex("uq_result_ra_description")
      .on(table.projectId, table.descriptionId)
      .where(sql`${table.isRa} AND ${table.descriptionId} IS NOT NULL`),
    uqResultRaPartCode: uniqueIndex("uq_result_ra_part_code")
      .on(table.projectId, table.partCodeId)
      .where(sql`${table.isRa} AND ${table.partCodeId} IS NOT NULL`),
  })
);

/* =========================================================
   TYPED DETAIL TABLES (Class Table Inheritance)
========================================================= */

/* MGI — Marine Growth Inspection */
export const resultMgi = pgTable(
  "result_mgi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),

    noMgObserved: integer("no_mg_observed").notNull().default(0),
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

/* CP — Cathodic Protection */
export const resultCp = pgTable("result_cp", {
  resultId: integer("result_id")
    .primaryKey()
    .references(() => result.resultId, { onDelete: "cascade" }),
  anodeType: text("anodeType"),
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

/* FMD — Flooded Member Detection */
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

/* SCOUR */
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


/* GVI — General Visual Inspection */
export const resultGvi = pgTable(
  "result_gvi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => result.resultId, { onDelete: "cascade" }),

    depthEl: doublePrecision("depth_el"),

    condition: gviCondition("condition").notNull(),

    ...createdAt,
    ...updatedAt,
  }
);

/* GVI — CP Findings */
export const resultGviFinding = pgTable(
  "result_gvi_finding",
  {
    findingId: integer("finding_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    resultGviId: integer("result_gvi_id")
      .notNull()
      .references(() => resultGvi.resultId, { onDelete: "cascade" }),

    value: doublePrecision("value"),
    remark: text("remark"),
    sortOrder: integer("sort_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultGviFindingGvi: index("idx_result_gvi_finding_gvi").on(
      table.resultGviId
    ),
  })
);



/* GVI — Marine Growth Inspection */
export const resultGviMgi = pgTable(
  "result_gvi_mgi",
  {
    resultId: integer("result_id")
      .primaryKey()
      .references(() => resultGvi.resultId, { onDelete: "cascade" }),

    ...createdAt,
    ...updatedAt,
  }
);



/* GVI — Marine Growth Findings */
export const resultGviMgiFinding = pgTable(
  "result_gvi_mgi_finding",
  {
    findingId: integer("finding_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    resultGviMgiId: integer("result_gvi_mgi_id")
      .notNull()
      .references(() => resultGviMgi.resultId, { onDelete: "cascade" }),

    depth: doublePrecision("depth"),
    softCoveragePercent: integer("soft_coverage_percent"),
    hardCoveragePercent: integer("hard_coverage_percent"),
    remarks: text("remarks"),
    sortOrder: integer("sort_order").notNull().default(0),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultGviMgiFindingMgi: index(
      "idx_result_gvi_mgi_finding_mgi"
    ).on(table.resultGviMgiId),
  })
);




/* CVI — Close Visual Inspection */
export const resultCvi = pgTable("result_cvi", {
  resultId: integer("result_id")
    .primaryKey()
    .references(() => result.resultId, { onDelete: "cascade" }),

  datumReference: text("datum_reference"),

  ...createdAt,
  ...updatedAt,
});

export const resultCviPosition = pgTable(
  "result_cvi_position",
  {
    positionId: integer("position_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => resultCvi.resultId, { onDelete: "cascade" }),

    memberType: cviMemberType("member_type").notNull(),
    clockPosition: text("clock_position").notNull(),
    utMm: doublePrecision("ut_mm"),
    findings: text("findings"),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultCviPositionResultId: index(
      "idx_result_cvi_position_result_id"
    ).on(table.resultId),
  })
);

export const resultCviFinding = pgTable(
  "result_cvi_finding",
  {
    findingId: integer("finding_id")
      .primaryKey()
      .generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => resultCvi.resultId, { onDelete: "cascade" }),

    value: doublePrecision("value"),
    remark: text("remark"),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultCviFindingResultId: index(
      "idx_result_cvi_finding_result_id"
    ).on(table.resultId),
  })
);


/* DVI — Detailed Visual Inspection */
export const resultDvi = pgTable(
  "result_dvi",
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

export const resultDviPosition = pgTable(
  "result_dvi_position",
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
    idxResultDviPositionResultId: index("idx_result_dvi_position_result_id").on(table.resultId),
  })
);




/* BSI — Bolted Support Inspection */
export const resultBsi = pgTable("result_bsi", {
  resultId: integer("result_id")
    .primaryKey()
    .references(() => result.resultId, { onDelete: "cascade" }),

  clampType: text("clamp_type"),
  depthEl: doublePrecision("depth_el"),

  clampBoltNutQuantity: integer("clamp_bolt_nut_quantity"),

  outboardClampCP: doublePrecision("outboard_clamp_cp"),
  cpAnomalyRecommendation: text("cp_anomaly_recommendation"),

  hingePin: boolean("hinge_pin"),
  hingeBoltNutQuantity: integer("hinge_bolt_nut_quantity"),

  liners: boolean("liners"),

  inboardGapCondition: bsiGapCondition("inboard_gap_condition").notNull(),
  inboardEstimateGap: doublePrecision("inboard_estimate_gap"),
  inboardAlignmentCondition: bsiAlignmentCondition("inboard_alignment_condition").notNull(),
  inboardMisalignedPosition: bsiMisalignedPosition("inboard_misaligned_position"),
  inboardAnomalyRecommendation: text("inboard_anomaly_recommendation"),

  outboardGapCondition: bsiGapCondition("outboard_gap_condition").notNull(),
  outboardEstimateGap: doublePrecision("outboard_estimate_gap"),
  outboardAlignmentCondition: bsiAlignmentCondition("outboard_alignment_condition").notNull(),
  outboardMisalignedPosition: bsiMisalignedPosition("outboard_misaligned_position"),
  outboardAnomalyRecommendation: text("outboard_anomaly_recommendation"),

  ...createdAt,
  ...updatedAt,
});

// missing-part lists: one row per missing bolt/washer clock position
export const resultBsiClampMissingBolt = pgTable(
  "result_bsi_clamp_missing_bolt",
  {
    missingBoltId: integer("missing_bolt_id").primaryKey().generatedByDefaultAsIdentity(),
    resultId: integer("result_id")
      .notNull()
      .references(() => resultBsi.resultId, { onDelete: "cascade" }),
    position: text("position").notNull(),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultBsiClampMissingBoltResultId: index("idx_result_bsi_clamp_missing_bolt_result_id").on(
      table.resultId,
    ),
  }),
);

export const resultBsiClampMissingWasher = pgTable(
  "result_bsi_clamp_missing_washer",
  {
    missingWasherId: integer("missing_washer_id").primaryKey().generatedByDefaultAsIdentity(),
    resultId: integer("result_id")
      .notNull()
      .references(() => resultBsi.resultId, { onDelete: "cascade" }),
    position: text("position").notNull(),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultBsiClampMissingWasherResultId: index(
      "idx_result_bsi_clamp_missing_washer_result_id",
    ).on(table.resultId),
  }),
);

export const resultBsiHingeMissingBolt = pgTable(
  "result_bsi_hinge_missing_bolt",
  {
    missingBoltId: integer("missing_bolt_id").primaryKey().generatedByDefaultAsIdentity(),
    resultId: integer("result_id")
      .notNull()
      .references(() => resultBsi.resultId, { onDelete: "cascade" }),
    position: text("position").notNull(),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultBsiHingeMissingBoltResultId: index("idx_result_bsi_hinge_missing_bolt_result_id").on(
      table.resultId,
    ),
  }),
);

export const resultBsiHingeMissingWasher = pgTable(
  "result_bsi_hinge_missing_washer",
  {
    missingWasherId: integer("missing_washer_id").primaryKey().generatedByDefaultAsIdentity(),
    resultId: integer("result_id")
      .notNull()
      .references(() => resultBsi.resultId, { onDelete: "cascade" }),
    position: text("position").notNull(),
    sortOrder: integer("sort_order").notNull(),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    idxResultBsiHingeMissingWasherResultId: index(
      "idx_result_bsi_hinge_missing_washer_result_id",
    ).on(table.resultId),
  }),
);


/* CGB — Conductor Guide Bucket */
export const resultCgb = pgTable("result_cgb", {
  resultId: integer("result_id")
    .primaryKey()
    .references(() => result.resultId, { onDelete: "cascade" }),

  movement: cgbYesNo("movement"),
  remark: text("remark"),
  debris: cgbYesNo("debris"),
  debrisType: text("debris_type"),

  ...createdAt,
  ...updatedAt,
});


/* =========================================================
   TIMELINE THUMBNAIL (filmstrip for the session master)
========================================================= */
export const timelineThumbnail = pgTable(
  "timeline_thumbnail",
  {
    thumbnailId: integer("thumbnail_id").primaryKey().generatedByDefaultAsIdentity(),

    // points at session now that master_video is merged in
    sessionId: integer("session_id")
      .notNull()
      .references(() => session.sessionId, { onDelete: "cascade" }),

    timestampMs: integer("timestamp_ms").notNull(),
    storageStem: text("storage_stem").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sizeBytes: integer("size_bytes").notNull(),

    ...createdAt,
  },
  (table) => ({
    idxTimelineThumbnailSessionTs: index("idx_timeline_thumbnail_session_ts").on(
      table.sessionId,
      table.timestampMs,
    ),
  })
);

/* =========================================================
   VIDEO CLIP (one per result / inspection instance)
========================================================= */
export const videoClip = pgTable(
  "video_clip",
  {
    clipId: integer("clip_id").primaryKey().generatedByDefaultAsIdentity(),

    resultId: integer("result_id")
      .notNull()
      .references(() => result.resultId, { onDelete: "cascade" }),

    // cascade: a project teardown drops the session, so its clips follow
    sessionId: integer("session_id")
      .notNull()
      .references(() => session.sessionId, { onDelete: "cascade" }),

    startOffsetMs: integer("start_offset_ms").notNull(),
    endOffsetMs: integer("end_offset_ms"),
    thumbnailKey: text("thumbnail_key"),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uqVideoClipResultId: uniqueIndex("uq_video_clip_result_id").on(table.resultId),
    idxVideoClipSessionId: index("idx_video_clip_session_id").on(table.sessionId),
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

    storageStem: text("storage_stem").notNull(),
    contentType: text("content_type").notNull().default("image/png"),
    hasAnnotated: boolean("has_annotated").notNull().default(false),
    remarks: text("remarks"),
  },
  (table) => ({
    idxResultImageResultId: index("idx_result_image_result_id").on(table.resultId),
  })
);

/* =========================================================
   RECORDING INGEST (direct protocol)
   One row per capture attempt (session master or inspection clip).
   kind drives the XOR: master points at session, clip at video_clip.
========================================================= */
export const recordingIngestKind = pgEnum("recording_ingest_kind", ["master", "clip"]);

export const recordingIngest = pgTable(
  "recording_ingest",
  {
    ingestId: integer("ingest_id").primaryKey().generatedByDefaultAsIdentity(),
    kind: recordingIngestKind("kind").notNull(),

    // exactly one target (check below); cascade so ingest dies with its domain row
    sessionId: integer("session_id").references(() => session.sessionId, {
      onDelete: "cascade",
    }),
    clipId: integer("clip_id").references(() => videoClip.clipId, { onDelete: "cascade" }),

    ticketHash: text("ticket_hash").notNull(),
    keyDate: date("key_date", { mode: "string" }).notNull(),
    keyPrefix: text("key_prefix").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastSegmentAt: timestamp("last_segment_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    contiguousSequence: integer("contiguous_sequence").notNull().default(-1),
    finalSequence: integer("final_sequence"),
    durationMs: integer("duration_ms"),

    ...createdAt,
    ...updatedAt,
  },
  (table) => ({
    recordingIngestKindTargetCheck: check(
      "recording_ingest_kind_target_check",
      sql`(${table.kind} = 'master' AND ${table.sessionId} IS NOT NULL AND ${table.clipId} IS NULL)
       OR (${table.kind} = 'clip' AND ${table.clipId} IS NOT NULL AND ${table.sessionId} IS NULL)`,
    ),
    // one open ingest per clip
    uqRecordingIngestOpenClip: uniqueIndex("uq_recording_ingest_open_clip")
      .on(table.clipId)
      .where(sql`${table.closedAt} IS NULL AND ${table.kind} = 'clip'`),
    // one open ingest per session master
    uqRecordingIngestOpenSession: uniqueIndex("uq_recording_ingest_open_session")
      .on(table.sessionId)
      .where(sql`${table.closedAt} IS NULL AND ${table.kind} = 'master'`),
    idxRecordingIngestOpen: index("idx_recording_ingest_open").on(table.closedAt),
  })
);

/* =========================================================
   RECORDING INGEST SEGMENT
========================================================= */
export const recordingIngestSegment = pgTable(
  "recording_ingest_segment",
  {
    ingestId: integer("ingest_id")
      .notNull()
      .references(() => recordingIngest.ingestId, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
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
