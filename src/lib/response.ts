import type { Context } from "hono";

export function ok(c: Context, data: unknown, status = 200) {
  return c.json({ ok: true, data }, status);
}
