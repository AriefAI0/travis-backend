import type { InspectionTypeCode, ResultSummaryDetail } from "./api";

// Verbatim copy of the app's src/shared/result.ts formatResultValue.
// Keep in sync with the app (pure display helper, DB-free).

/**
 * Pure renderer for a result's display value. DB-free so it can be unit-tested
 * without seeding. GVI/CVI → condition; CP → voltage in mV; FMD → flooded flag;
 * MGI → finding count (or "No MG" when none observed).
 */
export const formatResultValue = (
  inspectionTypeCode: InspectionTypeCode,
  detail: ResultSummaryDetail | null,
): string => {
  if (!detail) {
    return "—";
  }

  switch (inspectionTypeCode) {
    case "GVI":
      return detail.condition === "ok" ? "Good Condition" : "Visual Damage";
    case "CVI": {
      const memberType = detail.memberType ?? "chord";
      const cpText = detail.cpPotentialMv != null
        ? `${detail.cpPotentialMv} mV`
        : "N/A";

      return `${memberType.toUpperCase()} | CP ${cpText}`;
    }
    case "DVI": {
      const memberType = detail.memberType ?? "chord";
      const cpText = detail.cpPotentialMv != null
        ? `${detail.cpPotentialMv} mV`
        : "N/A";

      return `${memberType.toUpperCase()} | CP ${cpText}`;
    }
    case "CP":
      return detail.voltageMv == null ? "—" : `${detail.voltageMv} mV`;
    case "FMD":
      return detail.initialAttempt === "dry" ? "Dry" :
      detail.initialAttempt === "flooded" ? "Flooded" : "N/A";
    case "SCOUR":
      return detail.exposedPile === "exposed" ? "Exposed" :
      detail.exposedPile === "not_exposed" ? "Not exposed" : "N/A";
    case "MGI":
      return detail.noMgObserved ? "No MG" : `${detail.findingCount ?? 0} findings`;
    case "BSI":
      return detail.clampType ?? "—";
    default:
      return "—";
  }
};
