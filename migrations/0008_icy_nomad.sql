DROP TABLE "backend_identity" CASCADE;--> statement-breakpoint
DROP TABLE "recording_discard_audit" CASCADE;--> statement-breakpoint
DROP TABLE "recording_finalize_job" CASCADE;--> statement-breakpoint
DROP TABLE "recording_segment" CASCADE;--> statement-breakpoint
DROP TABLE "recording_upload" CASCADE;--> statement-breakpoint
DROP TYPE "public"."recording_capture_state";--> statement-breakpoint
DROP TYPE "public"."recording_job_state";--> statement-breakpoint
DROP TYPE "public"."recording_segment_receipt_state";--> statement-breakpoint
DROP TYPE "public"."recording_upload_kind";