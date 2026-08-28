import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "./error";

const idSchema = z.coerce.number().int().positive();

// first zod issue as "path: message"
const describe = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
};

// flow: read json > schema > data (validation_error on mismatch)
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.output<S>> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", describe(parsed.error));
  }
  return parsed.data;
}

// path id param -> positive integer (validation_error otherwise)
export function parseId(c: Context, name: string): number {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", `${name}: expected positive integer`);
  }
  return parsed.data;
}

// query object via schema (validation_error otherwise)
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError(400, "validation_error", describe(parsed.error));
  }
  return parsed.data;
}

// PATCH bodies: drop undefined-valued keys, reject nothing-to-update
export function compactUpdate<T extends Record<string, unknown>>(data: T): T {
  const next = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  ) as T;
  if (Object.keys(next).length === 0) {
    throw new AppError(400, "validation_error", "no fields to update");
  }
  return next;
}
