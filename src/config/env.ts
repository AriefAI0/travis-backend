import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  BUCKET_MASTER: z.string().min(1).default("travis-media"),
  BUCKET_CLIP: z.string().min(1).default("travis-clip"),
  BUCKET_HLS: z.string().min(1).default("travis-hls"),
  BUCKET_MKV: z.string().min(1).default("travis-mkv"),
  BUCKET_THUMBNAILS: z.string().min(1).default("travis-thumbs"),
  PART_SIZE_BYTES: z.coerce.number().int().positive().default(16_777_216),
  BUFFER_CAP_BYTES: z.coerce.number().int().positive().default(67_108_864),
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().positive().default(4),
  SEGMENT_STALE_SECONDS: z.coerce.number().int().positive().default(30),
  RESUME_GRACE_MINUTES: z.coerce.number().int().positive().default(10),
  PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  DATA_DIR: z.string().min(1).default("./data"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFMPEG_CONCURRENCY: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
  env.BUCKET_MASTER,
  env.BUCKET_CLIP,
  env.BUCKET_HLS,
  env.BUCKET_MKV,
  env.BUCKET_THUMBNAILS,
] as const;
