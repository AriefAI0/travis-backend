CREATE TYPE "public"."recording_capture_state" AS ENUM('recording', 'stopped', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."recording_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recording_segment_receipt_state" AS ENUM('reserved', 'stored');--> statement-breakpoint
CREATE TYPE "public"."recording_upload_kind" AS ENUM('master', 'clip');--> statement-breakpoint
CREATE TABLE "backend_identity" (
	"singleton_id" integer PRIMARY KEY NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"recovery_authority_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backend_identity_singleton_check" CHECK ("backend_identity"."singleton_id" = 1)
);
--> statement-breakpoint
CREATE TABLE "recording_discard_audit" (
	"discard_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"backend_instance_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_recording_discard_audit_request_recording" UNIQUE("request_id","recording_id")
);
--> statement-breakpoint
CREATE TABLE "recording_finalize_job" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"target_revision" integer NOT NULL,
	"state" "recording_job_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner_id" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_recording_finalize_job_recording_revision" UNIQUE("recording_id","target_revision")
);
--> statement-breakpoint
CREATE TABLE "recording_segment" (
	"recording_id" uuid NOT NULL,
	"segment_index" integer NOT NULL,
	"expected_checksum" text NOT NULL,
	"expected_size_bytes" bigint NOT NULL,
	"object_key" text NOT NULL,
	"receipt_state" "recording_segment_receipt_state" DEFAULT 'reserved' NOT NULL,
	"stored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_segment_recording_id_segment_index_pk" PRIMARY KEY("recording_id","segment_index")
);
--> statement-breakpoint
CREATE TABLE "recording_upload" (
	"recording_id" uuid PRIMARY KEY NOT NULL,
	"protocol_version" integer NOT NULL,
	"backend_instance_id" uuid NOT NULL,
	"admission_hash" text NOT NULL,
	"kind" "recording_upload_kind" NOT NULL,
	"master_video_id" integer,
	"clip_id" integer,
	"object_prefix" text NOT NULL,
	"capture_state" "recording_capture_state" DEFAULT 'recording' NOT NULL,
	"final_segment_index" integer,
	"last_heartbeat_at" timestamp with time zone,
	"segment_revision" integer DEFAULT 0 NOT NULL,
	"published_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_upload_kind_target_check" CHECK (("recording_upload"."kind" = 'master' AND "recording_upload"."master_video_id" IS NOT NULL AND "recording_upload"."clip_id" IS NULL)
       OR ("recording_upload"."kind" = 'clip' AND "recording_upload"."clip_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "recording_finalize_job" ADD CONSTRAINT "recording_finalize_job_recording_id_recording_upload_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording_upload"("recording_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_segment" ADD CONSTRAINT "recording_segment_recording_id_recording_upload_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recording_upload"("recording_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_upload" ADD CONSTRAINT "recording_upload_master_video_id_master_video_master_video_id_fk" FOREIGN KEY ("master_video_id") REFERENCES "public"."master_video"("master_video_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_upload" ADD CONSTRAINT "recording_upload_clip_id_video_clip_clip_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."video_clip"("clip_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_recording_finalize_job_claim" ON "recording_finalize_job" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_recording_segment_state" ON "recording_segment" USING btree ("receipt_state");--> statement-breakpoint
CREATE INDEX "idx_recording_upload_backend_instance_id" ON "recording_upload" USING btree ("backend_instance_id");--> statement-breakpoint
CREATE INDEX "idx_recording_upload_capture_state" ON "recording_upload" USING btree ("capture_state");