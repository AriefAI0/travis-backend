ALTER TABLE "result_image" ALTER COLUMN "storage_stem" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "timeline_thumbnail" ALTER COLUMN "storage_stem" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "file_url";--> statement-breakpoint
ALTER TABLE "master_video" DROP COLUMN "thumbnail_url";--> statement-breakpoint
ALTER TABLE "result_image" DROP COLUMN "raw_url";--> statement-breakpoint
ALTER TABLE "result_image" DROP COLUMN "annotated_url";--> statement-breakpoint
ALTER TABLE "timeline_thumbnail" DROP COLUMN "image_path";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "clip_file_url";--> statement-breakpoint
ALTER TABLE "video_clip" DROP COLUMN "thumbnail_url";