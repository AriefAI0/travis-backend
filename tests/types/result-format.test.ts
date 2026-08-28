import { describe, expect, it } from "bun:test";

import { formatResultValue } from "../../src/types/result-format";

describe("formatResultValue", () => {
  it("renders GVI/CVI condition", () => {
    expect(formatResultValue("GVI", { condition: "ok" })).toBe("Good Condition");
    expect(formatResultValue("GVI", { condition: "not_ok" })).toBe("Visual Damage");
  });

  it("renders CVI summary", () => {
    expect(
      formatResultValue("CVI", {
        memberType: "chord",
        cpPotentialMv: -850,
      }),
    ).toBe("CHORD | CP -850 mV");

    expect(
      formatResultValue("CVI", {
        memberType: "brace",
        cpPotentialMv: -1200,
      }),
    ).toBe("BRACE | CP -1200 mV");

    expect(
      formatResultValue("CVI", {
        memberType: "chord",
        cpPotentialMv: null,
      }),
    ).toBe("CHORD | CP N/A");
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
