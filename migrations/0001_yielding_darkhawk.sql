CREATE TYPE "public"."result_class" AS ENUM('normal', 'anomaly');--> statement-breakpoint
ALTER TABLE "result" ADD COLUMN "result_class" "result_class" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_result_project_class" ON "result" USING btree ("project_id","result_class");