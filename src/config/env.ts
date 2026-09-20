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
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  RECORDING_V2_ENABLED: z.stringbool().default(false),
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
  // Still frames a filmstrip may produce for one master.
  THUMBNAIL_MAX_STILLS: z.coerce.number().int().positive().default(20),
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
