CREATE TABLE "clip_mkv_cache" (
	"ingest_id" integer PRIMARY KEY NOT NULL,
	"segment_count" integer NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_mkv_cache" ADD CONSTRAINT "clip_mkv_cache_ingest_id_recording_ingest_ingest_id_fk" FOREIGN KEY ("ingest_id") REFERENCES "public"."recording_ingest"("ingest_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_clip_mkv_cache_last_used" ON "clip_mkv_cache" USING btree ("last_used_at");