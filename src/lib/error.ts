import type { Context, ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "./logger";

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// 404 helper for missing rows
export const notFound = (what: string) =>
  new AppError(404, "not_found", `${what} not found`);

// RFC 7807-style error body.
function problem(c: Context, status: ContentfulStatusCode, code: string, title: string) {
  return c.json({ status, code, title }, status, { "Content-Type": "application/problem+json" });
}

// service-layer message -> app error vocabulary (codes steve branches on)
const WRONG_STATE = /already in progress|has already been completed|cannot be cancelled|Only finalized master videos/;
const NOT_FOUND = /does not exist$|Parent (asset|component) not found/;
const VALIDATION =
  /must be a (positive|non-negative) integer|is required$|is invalid|must be greater than|exceeds master video duration/;

// pg error code from err or its cause chain (drizzle wraps some errors)
const pgErrorCode = (err: unknown): string | undefined => {
  let current: unknown = err;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return problem(c, err.status, err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (WRONG_STATE.test(message)) {
    return problem(c, 409, "wrong_state", message);
  }
  if (NOT_FOUND.test(message)) {
    return problem(c, 404, "not_found", message);
  }
  if (VALIDATION.test(message)) {
    return problem(c, 400, "validation_error", message);
  }
  const pgCode = pgErrorCode(err);
  // FK violation -> referenced row missing; unique -> duplicate row
  if (pgCode === "23503") {
    return problem(c, 404, "not_found", "Referenced record not found");
  }
  if (pgCode === "23505") {
    return problem(c, 409, "wrong_state", "Record already exists");
  }
  log.error("unhandled error", { path: c.req.path, err: String(err) });
  return problem(c, 500, "internal", "Internal server error");
};
