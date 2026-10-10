import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "must start with postgres:// or postgresql://",
    }),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  // One bucket holds every media object: raw segments, stills, exports, images.
  BUCKET_MEDIA: z.string().min(1).default("travis-media"),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  // Browser origins allowed to fetch HLS. Dev renderer is localhost; the
  // packaged renderer loads from file://, which sends Origin: null.
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:5173,null"),
  RECORDING_V2_TOKEN: z.string().min(1).optional(),
  // signing key for scoped playback tokens; required, separate from ingest tickets
  PLAYBACK_TOKEN_SECRET: z
    .string()
    .min(32, { message: "must be at least 32 characters" }),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFMPEG_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // One FFmpeg run may not outlive this. A hung encoder is killed, never
  // waited on: thumbnails are best effort and must not pin a worker slot.
  FFMPEG_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Filmstrip grid: one still per interval while the recording is short, the
  // interval doubling as it grows so the grid never passes the sample budget.
  THUMBNAIL_SAMPLE_BASE_MS: z.coerce.number().int().positive().default(10_000),
  THUMBNAIL_MAX_SAMPLES: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

// Report every invalid/missing var in one shot so a single boot surfaces them all.
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  console.error(`Invalid environment:\n${problems}`);
  process.exit(1);
}

export const env = parsed.data;

// Every bucket the server owns. All are ensured to exist at boot.
export const buckets = [env.BUCKET_MEDIA] as const;

// Origins the renderer may play from; blank entries dropped.
export const corsAllowedOrigins = env.CORS_ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
