import { describe, expect, it } from "bun:test";

import { formatResultValue } from "../../src/types/result-format";

describe("formatResultValue", () => {
  it("renders GVI summary from the tool's own fields", () => {
    expect(formatResultValue("GVI", { condition: "ok" })).toBe("CP: N/A, UT: N/A, Good Condition");
    expect(formatResultValue("GVI", { condition: "not_ok" })).toBe(
      "CP: N/A, UT: N/A, Visual Damage",
    );
    expect(
      formatResultValue("GVI", {
        kpRange: "KP-2",
        depthEl: 1.25,
        gviCp: -900,
        gviUt: 12,
        condition: "ok",
      }),
    ).toBe("KP: KP-2, Depth EL: 1.25, CP: -900 mV, UT: 12 mm, Good Condition");
  });

  it("renders CVI summary from members and findings", () => {
    // schema-update model: member type per position, CP per finding
    expect(
      formatResultValue("CVI", {
        memberTypes: ["chord"],
        cpValues: [-850],
      }),
    ).toBe("CHORD | CP -850 mV");

    expect(
      formatResultValue("CVI", {
        memberTypes: ["brace"],
        cpValues: [-1200],
      }),
    ).toBe("BRACE | CP -1200 mV");

    expect(
      formatResultValue("CVI", {
        memberTypes: ["chord"],
        cpValues: [null],
      }),
    ).toBe("CHORD | CP N/A");

    // more than one member type on the result
    expect(
      formatResultValue("CVI", {
        memberTypes: ["chord", "brace", "chord"],
        cpValues: [null, -900],
      }),
    ).toBe("CHORD, BRACE | CP -900 mV");

    // no positions recorded yet falls back to the default member
    expect(formatResultValue("CVI", { datumReference: "D-1" })).toBe("CHORD | CP N/A");
  });

  it("renders the phase-2 type summaries", () => {
    expect(formatResultValue("CGB", { movement: "yes" })).toBe("Movement");
    expect(formatResultValue("CGB", { movement: "no", debris: "yes" })).toBe("Debris");
    expect(formatResultValue("CGB", { movement: "no", debris: "no" })).toBe("Clear");

    expect(formatResultValue("RISER", { coatingStatus: "present" })).toBe("Coating present");
    expect(formatResultValue("RISER", { coatingStatus: "not-present", anomaly: "yes" })).toBe("Anomaly");
    expect(formatResultValue("RISER", { coatingStatus: null, anomaly: "no" })).toBe("No anomaly");

    expect(formatResultValue("CAISSON", { gratingBlockage: "25_50" })).toBe("Grating 25-50%");
    expect(formatResultValue("CAISSON", { visualDamage: true })).toBe("Visual damage");
    expect(formatResultValue("CAISSON", { visualDamage: false })).toBe("No damage");

    expect(formatResultValue("SEABED", { seabedFindings: [] })).toBe("0 findings");

    expect(formatResultValue("PIPELINE", { location: "KP-1" })).toBe("KP-1");
    expect(formatResultValue("PIPELINE", { location: "" })).toBe("0 findings");
  });

  it("renders CP voltage in mV", () => {
    expect(formatResultValue("CP", { voltageMv: -850 })).toBe("-850 mV");
    expect(formatResultValue("CP", { voltageMv: 0 })).toBe("0 mV");
    expect(formatResultValue("CP", { voltageMv: null })).toBe("—");
  });

  it("renders FMD initial attempt result", () => {
    expect(formatResultValue("FMD", { initialAttempt: "flooded" })).toBe("Flooded");
    expect(formatResultValue("FMD", { initialAttempt: "dry" })).toBe("Dry");
    expect(formatResultValue("FMD", { initialAttempt: "na" })).toBe("N/A");
  });

  it("renders MGI finding count, or \"No MG\" when none observed", () => {
    expect(formatResultValue("MGI", { noMgObserved: 0, findingCount: 3 })).toBe("3 findings");
    expect(formatResultValue("MGI", { noMgObserved: 0, findingCount: 1 })).toBe("1 findings");
    expect(formatResultValue("MGI", { noMgObserved: 1, findingCount: 0 })).toBe("No MG");
  });

  it("falls back to an em-dash when the typed detail is missing", () => {
    expect(formatResultValue("CP", null)).toBe("—");
    expect(formatResultValue("GVI", null)).toBe("—");
    expect(formatResultValue("MGI", null)).toBe("—");
  });
});
