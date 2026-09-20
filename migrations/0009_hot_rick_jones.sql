ALTER TABLE "master_video" DROP COLUMN "storage_stem";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "recording_status";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "file_size";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "storage_stem";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "recording_status";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "file_size";--> statement-breakpoint
DROP TYPE "public"."recording_status";