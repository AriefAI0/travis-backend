import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { blankMissingValue, renderTemplate } from "../../../src/lib/docx/render";
import { templatesDir } from "../../../src/lib/docx/templates";
import { env } from "../../../src/config/env";
import { convertDocxToPdf } from "../../../src/lib/pdf/convert";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

// soffice ships in the runtime image. A dev host may not carry it, and the
// conversion check needs the real binary.
const sofficeAvailable = Bun.which(env.SOFFICE_PATH) !== null;

const HEADER = {
  Client: "TOTAL E&P",
  ReportNo: "TRV-2026-001",
  Date: "2026-10-22",
  Session: "SESSION-03",
};

// Fixture rows per kind, shaped as the render data contract.
const FIXTURES: Record<string, { data: Record<string, unknown>; expect: string[] }> = {
  gvi: {
    data: {
      ...HEADER,
      rows: [
        { component_id: "A-1201", component_type: "BRACE", depth_el: "-82.4", condition: "Good", remarks: "MG" },
        { component_id: "A-1202", component_type: "JACKET", depth_el: "-83.1", condition: "Dent", remarks: "3 o'clock" },
      ],
    },
    expect: ["A-1201", "A-1202", "BRACE", "JACKET", "-82.4", "Dent"],
  },
  cp_anode: {
    data: {
      ...HEADER,
      rows: [
        {
          component_id: "A-1180",
          anode_type: "SLENDER",
          voltage_mv: "-980",
          depletion: "15",
          anode_width: "100",
          anode_height: "80",
          anode_length: "300",
          widest_pit: "12",
          deepest_pit: "8",
          remarks: "Good condition",
        },
      ],
    },
    expect: ["A-1180", "SLENDER", "-980", "15", "100", "80", "300", "12", "8"],
  },
  cp_member: {
    data: {
      ...HEADER,
      rows: [
        {
          component_id: "A-1210",
          cp_mv: "-950",
          wall_mm: "20.1",
          clock_12: "√",
          clock_3: "",
          clock_6: "",
          clock_9: "",
          remarks: "Nominal",
        },
        {
          component_id: "A-1210",
          cp_mv: "",
          wall_mm: "",
          clock_12: "",
          clock_3: "",
          clock_6: "",
          clock_9: "",
          remarks: "CP reading taken",
        },
      ],
    },
    expect: ["A-1210", "-950", "20.1", "√", "CP reading taken"],
  },
  fmd: {
    data: {
      ...HEADER,
      rows: [
        {
          component_id: "A-1205",
          component_type: "BRACE",
          depth_el: "-82.4",
          initial_attempt: "Dry",
          additional_attempt_1: "Flooded",
          additional_attempt_2: "N/A",
          additional_attempt_3: "N/A",
          remarks: "Confirmed dry",
        },
      ],
    },
    expect: ["A-1205", "BRACE", "-82.4", "Dry", "Flooded", "N/A", "Confirmed dry"],
  },
  scour: {
    data: {
      ...HEADER,
      scour_rows: [
        { location_leg1: "North", location_leg2: "South", dim_a: "300", dim_b: "150", dim_c: "250", exp_leg1: "Yes", exp_leg2: "No", height_exp_leg1: "120", height_exp_leg2: "" },
        { location_leg1: "East", location_leg2: "West", dim_a: "280", dim_b: "140", dim_c: "230", exp_leg1: "No", exp_leg2: "Yes", height_exp_leg1: "", height_exp_leg2: "95" },
        { location_leg1: "Northeast", location_leg2: "Southwest", dim_a: "180", dim_b: "95", dim_c: "120", exp_leg1: "No", exp_leg2: "No", height_exp_leg1: "", height_exp_leg2: "" },
      ],
    },
    expect: ["North", "South", "East", "West", "Northeast", "300", "150", "250", "120", "95"],
  },
};

const load = async (kind: string) =>
  Buffer.from(await Bun.file(templatesDir(`datasheets/${kind}.docx`)).arrayBuffer());

const pageOf = (docx: Buffer) =>
  new PizZip(docx).file("word/document.xml").asText() as string;

const render = async (kind: string) =>
  renderTemplate(await load(kind), FIXTURES[kind]!.data, { nullGetter: blankMissingValue });

describe("datasheet templates", () => {
  for (const kind of Object.keys(FIXTURES)) {
    it(`${kind}: renders its rows and leaves no tag behind`, async () => {
      const xml = pageOf(await render(kind));

      for (const value of FIXTURES[kind]!.expect) expect(xml).toContain(value);
      expect(xml).not.toMatch(/\{[#/]?[a-zA-Z_][a-zA-Z0-9_]*\}/);
      // the sheet index is a Word field, not a number the render writes
      expect(xml).toContain('<w:fldSimple w:instr=" PAGE ">');
      expect(xml).toContain('<w:fldSimple w:instr=" NUMPAGES ">');
    });
  }

  it("puts a spacer row after every scour result", async () => {
    const xml = pageOf(await render("scour"));

    // three results, three spacer rows: Word drops space-after in a cell, so
    // the gap is its own row
    expect(xml.match(/<w:trHeight w:val="480" w:hRule="atLeast"\/>/g) ?? []).toHaveLength(3);
  });

  it("a scour row clones its picture with a fresh drawing id", async () => {
    const xml = pageOf(await render("scour"));

    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it.skipIf(!sofficeAvailable)("every rendered datasheet converts to a PDF", async () => {
    for (const kind of Object.keys(FIXTURES)) {
      const pdf = await convertDocxToPdf(await render(kind));
      expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    }
  });
});
