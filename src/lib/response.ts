import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function ok(c: Context, data: unknown, status: ContentfulStatusCode = 200) {
  return c.json({ ok: true, data }, status);
}
