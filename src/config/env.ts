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
  BUCKET_RAW: z.string().min(1).default("travis-raw"),
  BUCKET_MEDIA: z.string().min(1).default("travis-media"),
  BUCKET_THUMBNAILS: z.string().min(1).default("travis-thumbs"),
  BUCKET_IMAGES: z.string().min(1).default("travis-images"),
  PART_SIZE_BYTES: z.coerce.number().int().positive().default(16_777_216),
  BUFFER_CAP_BYTES: z.coerce.number().int().positive().default(67_108_864),
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().default(4),
  SEGMENT_STALE_SECONDS: z.coerce.number().int().positive().default(30),
  RESUME_GRACE_MINUTES: z.coerce.number().positive().default(10),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  RECORDING_V2_ENABLED: z.stringbool().default(false),
  RECORDING_V2_TOKEN: z.string().min(1).optional(),
  // signing key for scoped playback tokens; required, separate from ingest tickets
  PLAYBACK_TOKEN_SECRET: z
    .string()
    .min(32, { message: "must be at least 32 characters" }),
  DATA_DIR: z.string().min(1).default("./data"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFMPEG_CONCURRENCY: z.coerce.number().int().positive().default(1),
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
export const buckets = [
  env.BUCKET_RAW,
  env.BUCKET_MEDIA,
  env.BUCKET_THUMBNAILS,
  env.BUCKET_IMAGES,
] as const;
