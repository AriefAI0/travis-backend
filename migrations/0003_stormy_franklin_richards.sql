ALTER TABLE "master_video" DROP COLUMN "source_kind";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "input_id";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "source_index";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "is_primary";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "source_name";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "stopped_at";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "recovery_status";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "finalization_error";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "recording_started_at";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "recording_stopped_at";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "recovery_status";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "finalization_error";