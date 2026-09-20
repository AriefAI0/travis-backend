ALTER TABLE "project" ADD COLUMN "display_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "result" ADD COLUMN "display_number" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_display_org" ON "project" USING btree ("organization_id","display_number") WHERE "project"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_display_noorg" ON "project" USING btree ("display_number") WHERE "project"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_result_session_display" ON "result" USING btree ("session_id","display_number");