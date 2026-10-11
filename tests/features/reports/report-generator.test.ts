import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import {
  closeTestDatabase,
  ensureTestDatabase,
  testDb,
  truncateTestDatabase,
} from "../../helpers/db";
import { generateReport } from "../../../src/features/reports/report-generator";
import { env } from "../../../src/config/env";
import { minio } from "../../../src/lib/minio_storage/clients";
import * as schema from "../../../src/db/schema";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

// 1x1 PNG. The render re-encodes whatever it reads, so this is enough to prove
// the picture reaches the page with its own size.
const EVIDENCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// One pixel is 9525 EMU, so a 1x1 picture proves the size came from the image.
const ONE_PIXEL_EMU = "9525";

beforeAll(ensureTestDatabase);
beforeEach(truncateTestDatabase);
afterAll(closeTestDatabase);

const mediaEntriesIn = (buf: Buffer) =>
  Object.keys(new PizZip(buf).files).filter((name) => name.startsWith("word/media/"));

const documentXmlIn = (buf: Buffer) =>
  new PizZip(buf).file("word/document.xml").asText() as string;

// project > session > group > code > description > type > part code > result
const seed = async () => {
  await testDb.insert(schema.project).values({
    projectId: 1,
    displayNumber: 1,
    title: "Alpha",
    documentId: "DOC-1",
  });
  await testDb.insert(schema.session).values({
    sessionId: 101,
    projectId: 1,
    displayNumber: 1,
    name: "Run 1",
  });
  await testDb.insert(schema.taskGroup).values({ taskGroupId: 1, projectId: 1, code: "100" });
  await testDb.insert(schema.taskCode).values({ taskCodeId: 10, taskGroupId: 1, code: "101" });
  await testDb.insert(schema.description).values({
    descriptionId: 100,
    taskCodeId: 10,
    label: "Leg A",
  });
  await testDb.insert(schema.type).values({ typeId: 200, descriptionId: 100, code: "T1" });
  await testDb.insert(schema.partCode).values({ partCodeId: 300, typeId: 200, code: "P1" });
  await testDb.insert(schema.result).values({
    resultId: 5001,
    displayNumber: 1,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    descriptionId: 100,
    layer: 1,
    masterStartMs: 0,
    remarks: "looks fine",
  });
  await testDb.insert(schema.resultImage).values({
    imageId: 9001,
    resultId: 5001,
    storageStem: "1-alpha/session-1/evidence-img",
    contentType: "image/png",
    hasAnnotated: false,
  });

  // the object behind that row, so the picture path actually runs
  await minio.putObject(
    env.BUCKET_MEDIA,
    "1-alpha/session-1/evidence-img/9001.png",
    EVIDENCE_PNG,
    EVIDENCE_PNG.byteLength,
    { "Content-Type": "image/png" },
  );

  // second result with NO image row: exercises the empty image-tag path
  await testDb.insert(schema.result).values({
    resultId: 5002,
    displayNumber: 2,
    projectId: 1,
    sessionId: 101,
    inspectionTypeCode: "GVI",
    partCodeId: 300,
    layer: 1,
    masterStartMs: 1000,
  });

  // the type table reads these columns, not a formatted summary string
  await testDb.insert(schema.resultGvi).values([
    { resultId: 5001, condition: "not_ok" },
    { resultId: 5002, depthEl: 1.25, condition: "ok" },
  ]);
  await testDb.insert(schema.resultGviFinding).values({
    resultGviId: 5002,
    value: -900,
    remark: "cp reading",
    sortOrder: 0,
  });
};

// one target carrying three inspection types at once
const seedMixedTypes = async () => {
  await seed();
  await testDb.insert(schema.result).values([
    {
      resultId: 5003,
      displayNumber: 3,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "CVI",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 2000,
    },
    {
      resultId: 5004,
      displayNumber: 4,
      projectId: 1,
      sessionId: 101,
      inspectionTypeCode: "MGI",
      descriptionId: 100,
      layer: 1,
      masterStartMs: 3000,
    },
  ]);
  await testDb.insert(schema.resultCvi).values({
    resultId: 5003,
    datumReference: "D-1",
  });
  await testDb.insert(schema.resultCviPosition).values({
    resultId: 5003,
    memberType: "chord",
    clockPosition: "12:00",
    utMm: 9.5,
    findings: "pitting",
    sortOrder: 0,
  });
  await testDb.insert(schema.resultCviFinding).values({
    resultId: 5003,
    value: -850,
    remark: "cp",
    sortOrder: 0,
  });
  await testDb.insert(schema.resultMgi).values({
    resultId: 5004,
    noMgObserved: 0,
    criteriaPreset: "client_cnc",
  });
  await testDb.insert(schema.resultMgiFinding).values({
    resultMgiId: 5004,
    growthType: "hard",
    species: "Barnacle",
    coveragePercent: 40,
    thicknessMm: 12,
    remarks: "heavy",
    sortOrder: 0,
  });
};

describe("generateReport", () => {
  it("renders the bundled template with data and one embedded image", async () => {
    await seed();

    const buf = await generateReport(1, testDb);

    // a docx is a zip, so the first two bytes are the zip magic
    expect(buf.subarray(0, 2).toString()).toBe("PK");

    const xml = documentXmlIn(buf);
    expect(xml).toContain("Alpha");
    expect(xml).toContain("DOC-1");
    expect(xml).toContain("100");
    expect(xml).toContain("Leg A");
    expect(xml).toContain("GVI Results");
    // schema-update shape: gvi_cp renders from the findings join, no KP range
    expect(xml).toContain("-900");
    expect(xml).toContain("1.25");
    expect(xml).toContain("Good Condition");
    expect(xml).toContain("looks fine");

    // no placeholder text may survive the render
    expect(xml).not.toContain("{task_group}");
    expect(xml).not.toContain("{#items}");
    expect(xml).not.toContain("{#sections}");
    expect(xml).not.toContain("{%image}");

    // Only the section that holds a picture draws one. The other item's section
    // has none, and an empty frame there would read as a defect.
    expect((xml.match(/<w:drawing>/g) ?? []).length).toBe(1);
    expect(mediaEntriesIn(buf)).toHaveLength(1);

    // the picture keeps its own size: a fixed box would stretch a photo
    expect(xml).toContain(`<wp:extent cx="${ONE_PIXEL_EMU}" cy="${ONE_PIXEL_EMU}"/>`);
    // Every table is followed by a paragraph, so the caret can land after it.
    // Inside a region the table closes it and the paragraph behind the region
    // serves; the item header table sits outside every region.
    expect(xml).not.toMatch(/<\/w:tbl>(?!<w:p|<\/w:sdtContent>)/);
    expect(xml).not.toContain("</w:tbl><w:tbl>");
  });

  it("renders a project that has no results and embeds no image", async () => {
    await testDb
      .insert(schema.project)
      .values({ projectId: 2, displayNumber: 2, title: "Empty" });

    const buf = await generateReport(2, testDb);

    expect(buf.subarray(0, 2).toString()).toBe("PK");
    expect(documentXmlIn(buf)).toContain("Empty");
    expect(mediaEntriesIn(buf)).toHaveLength(0);
  });

  it("renders one table per inspection type with that type's columns", async () => {
    await seedMixedTypes();

    const buf = await generateReport(1, testDb);
    const xml = documentXmlIn(buf);

    // one block per type on the target, each with its own heading
    expect(xml).toContain("GVI Results");
    expect(xml).toContain("CVI Results");
    expect(xml).toContain("MGI Results");
    // a type the project has no result for contributes no block at all
    expect(xml).not.toContain("BSI Results");
    expect(xml).not.toContain("SCOUR Results");

    // the columns each type actually reads
    expect(xml).toContain("-900");
    expect(xml).toContain("Good Condition");
    expect(xml).toContain("CHORD");
    expect(xml).toContain("-850");
    expect(xml).toContain("12:00");
    expect(xml).toContain("pitting");
    expect(xml).toContain("Barnacle");
    expect(xml).toContain("client_cnc");

    expect(xml).not.toContain("{#items}");
    expect(xml).not.toContain("{#sections}");
    expect(xml).not.toContain("{#isCVI}");
    expect(xml).not.toContain("{recorded}");
    expect(xml).not.toContain("{%image}");

    // exactly one frame: the description target's GVI section holds result
    // 5001's seeded evidence object, and no other section has a candidate
    expect((xml.match(/<w:drawing>/g) ?? []).length).toBe(1);
  });

  it("renders a section for each newly enabled type", async () => {
    await seed();

    // one result per type, all on the same target
    await testDb.insert(schema.result).values([
      { resultId: 5010, displayNumber: 10, projectId: 1, sessionId: 101, inspectionTypeCode: "CGB", descriptionId: 100, layer: 1, masterStartMs: 10 },
      { resultId: 5011, displayNumber: 11, projectId: 1, sessionId: 101, inspectionTypeCode: "RISER", descriptionId: 100, layer: 1, masterStartMs: 11 },
      { resultId: 5012, displayNumber: 12, projectId: 1, sessionId: 101, inspectionTypeCode: "CAISSON", descriptionId: 100, layer: 1, masterStartMs: 12 },
      { resultId: 5013, displayNumber: 13, projectId: 1, sessionId: 101, inspectionTypeCode: "SEABED", descriptionId: 100, layer: 1, masterStartMs: 13 },
      { resultId: 5014, displayNumber: 14, projectId: 1, sessionId: 101, inspectionTypeCode: "PIPELINE", descriptionId: 100, layer: 1, masterStartMs: 14 },
    ]);

    await testDb.insert(schema.resultCgb).values({
      resultId: 5010,
      movement: "yes",
      remark: "cgb-moved",
      debris: "no",
      debrisType: "n/a",
    });
    await testDb.insert(schema.resultRiser).values({
      resultId: 5011,
      touchdownDistanceFromRiserBend: "1.5",
      riserBendDistanceToMudbraceMember: "2.5",
      riserBendHeightToSeabed: "3.5",
      coatingStatus: "present",
      coatingCondition: "good",
      kneeBrace: "yes",
      debris: "no",
      debrisType: "n/a",
      anomaly: "no",
      recommendation: "riser-rec",
      restrictedAccess: "no",
    });
    await testDb.insert(schema.resultCi).values({
      resultId: 5012,
      visualDamage: false,
      visualDamageRecommendation: "vd-note",
      debrisPresent: true,
      debrisRecommendation: "deb-note",
      gratingPresent: true,
      gratingBlockage: "25_50",
      gratingAnomalyRecommendation: "gr-note",
      associatedPipesRecommendation: "pipes-note",
    });
    await testDb
      .insert(schema.resultCiGviAssociatedPipe)
      .values({ resultId: 5012, position: "P-1" });
    await testDb.insert(schema.resultCiCpFinding).values({
      resultId: 5012,
      cpMv: "-900",
      remarks: "low",
    });
    await testDb.insert(schema.resultSeabed).values({ resultId: 5013 });
    await testDb.insert(schema.resultSeabedFinding).values({
      resultId: 5013,
      rangeMeters: "12.5",
      fixes: "F-1",
      debris: "yes",
      debrisType: "hard",
    });
    await testDb.insert(schema.resultPipeline).values({
      resultId: 5014,
      location: "KP-1",
      depthEl: "2.5",
      orientation: "12_oclock",
    });
    await testDb.insert(schema.resultPipelineFinding).values({
      resultId: 5014,
      category: "damage",
      damageDimensions: "10x10",
      damageType: "crack",
      debrisDescription: "",
      stabilizationType: "",
      burialStart: "",
      burialEnd: "",
      freespansStart: "",
      freespansEnd: "",
      freespansLength: "",
      freespansHeight: "",
      leakType: "",
      leakDescription: "",
      crossingGapDistance: "",
      crossingDamageMovement: "",
      featuresType: "",
      remarks: "pi-remark",
    });

    const xml = documentXmlIn(await generateReport(1, testDb));

    for (const type of ["CGB", "RISER", "CAISSON", "SEABED", "PIPELINE"]) {
      expect(xml).toContain(`${type} Results`);
    }

    // one distinctive value per type, so a block cannot render empty
    expect(xml).toContain("cgb-moved");
    expect(xml).toContain("riser-rec");
    expect(xml).toContain("gr-note");
    expect(xml).toContain("P-1");
    expect(xml).toContain("-900");
    expect(xml).toContain("F-1");
    expect(xml).toContain("12.5");
    expect(xml).toContain("KP-1");
    expect(xml).toContain("pi-remark");

    // no placeholder text may survive any new block either
    expect(xml).not.toContain("{#isCGB}");
    expect(xml).not.toContain("{#isPIPELINE}");
    expect(xml).not.toContain("{movement}");
    expect(xml).not.toContain("{range_meters}");
    expect(xml).not.toContain("{pipeline_category}");
    expect(xml).not.toContain("{pipeline_debris}");
  });

  it("tags one region per picture and per table, so a refresh can find them", async () => {
    await seedMixedTypes();

    const tagsIn = (buf: Buffer) =>
      [...documentXmlIn(buf).matchAll(/<w:tag w:val="([^"]*)"\/>/g)].map((match) => match[1]!);

    const first = await generateReport(1, testDb);
    const second = await generateReport(1, testDb);

    // a picture region plus a table region per section: GVI, CVI and MGI on the
    // description target, and the second result's GVI on the part-code target
    expect(tagsIn(first).sort()).toEqual([
      "region:description:100:CVI:1",
      "region:description:100:CVI:picture",
      "region:description:100:GVI:1",
      "region:description:100:GVI:picture",
      "region:description:100:MGI:1",
      "region:description:100:MGI:picture",
      "region:part_code:300:GVI:1",
      "region:part_code:300:GVI:picture",
    ]);
    // a re-render must name the same regions, or a refresh would miss them
    expect(tagsIn(second)).toEqual(tagsIn(first));
    // the template's placeholder never survives
    expect(documentXmlIn(first)).not.toContain('w:val="region"');
  }, 20_000);

  it("ends every region with its table, so the paragraph behind it is the user's", async () => {
    await seedMixedTypes();

    const xml = documentXmlIn(await generateReport(1, testDb));

    // docxtemplater inserts a paragraph behind a table that closes a region,
    // since it cannot see the content control. The render removes it, which is
    // what leaves the paragraph after the table outside the region.
    expect(xml).not.toContain("</w:tbl><w:p/></w:sdtContent>");
    expect(xml).not.toMatch(/<\/w:tbl>(?!<w:p|<\/w:sdtContent>)/);
    // every region is followed by a paragraph the user can type into
    expect(xml).not.toMatch(/<\/w:sdt>(?!<w:p|<w:sdt)/);
    // and the document ends with a paragraph, never a table
    expect(xml).toMatch(/<w:p\/>\s*<w:sectPr>/);
  }, 20_000);

  it("rejects an unknown project", async () => {
    await expect(generateReport(999, testDb)).rejects.toThrow();
  });
});
