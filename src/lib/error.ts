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

// RFC 7807-style error body.
function problem(c: Context, status: ContentfulStatusCode, code: string, title: string) {
  return c.json({ status, code, title }, status, { "Content-Type": "application/problem+json" });
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof AppError) {
    return problem(c, err.status, err.code, err.message);
  }
  log.error("unhandled error", { path: c.req.path, err: String(err) });
  return problem(c, 500, "internal", "Internal server error");
};
