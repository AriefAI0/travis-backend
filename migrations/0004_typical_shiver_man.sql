ALTER TABLE "result" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "result" ADD COLUMN "is_ra" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_result_ra_description" ON "result" USING btree ("project_id","description_id") WHERE "result"."is_ra" AND "result"."description_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_result_ra_part_code" ON "result" USING btree ("project_id","part_code_id") WHERE "result"."is_ra" AND "result"."part_code_id" IS NOT NULL;