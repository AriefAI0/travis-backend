DROP INDEX "idx_video_clip_result_id";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_video_clip_result_id" ON "video_clip" USING btree ("result_id");