ALTER TABLE "master_video" ALTER COLUMN "start_epoch" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "master_video" ALTER COLUMN "end_epoch" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "master_video" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "result_cp" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "result_cvi" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "result_fmd" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "result_gvi" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "result_mgi" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "result_scour" ALTER COLUMN "result_id" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "video_clip" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "master_video" ADD COLUMN "storage_stem" text;--> statement-breakpoint
ALTER TABLE "result_image" ADD COLUMN "storage_stem" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "display_number" integer;--> statement-breakpoint
ALTER TABLE "timeline_thumbnail" ADD COLUMN "storage_stem" text;--> statement-breakpoint
ALTER TABLE "video_clip" ADD COLUMN "storage_stem" text;--> statement-breakpoint
CREATE INDEX "idx_master_video_session_id" ON "master_video" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_result_image_result_id" ON "result_image" USING btree ("result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_session_project_display" ON "session" USING btree ("project_id","display_number");--> statement-breakpoint
CREATE INDEX "idx_timeline_thumbnail_master_video_ts" ON "timeline_thumbnail" USING btree ("master_video_id","timestamp_ms");--> statement-breakpoint
CREATE INDEX "idx_video_clip_result_id" ON "video_clip" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "idx_video_clip_master_video_id" ON "video_clip" USING btree ("master_video_id");