import type { DbOrTx } from "../../db/client";
import { env } from "../../config/env";
import { AppError } from "../../lib/error";
import { generateReport as renderInProcess, loadReportInputs } from "./report-generator";

// A large project with many images is slow, so the ceiling stays generous.
const REQUEST_TIMEOUT_MS = 60_000;

// Render a project's report. With REPORT_GENERATOR_URL set the work happens in
// the generator service; unset, this process renders it.
// flow: inputs > remote POST > local render on any transport miss
export const generateReport = async (
  projectId: number,
  database?: DbOrTx,
): Promise<Buffer> => {
  if (!env.REPORT_GENERATOR_URL) {
    return renderInProcess(projectId, database);
  }

  // the app owns the data and the template; the service only fills it
  const { template, data } = await loadReportInputs(projectId, database);

  let response: Response;
  try {
    response = await fetch(new URL("/generate", env.REPORT_GENERATOR_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, template: template.toString("base64") }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // an unreachable service must not lose the report
    return renderInProcess(projectId, database);
  }

  if (!response.ok) {
    // a template the service cannot fill is the caller's problem, not a miss
    const detail = await response.text();
    throw new AppError(
      500,
      "template_error",
      detail || `generator service answered ${response.status}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
};
