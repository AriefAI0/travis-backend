CREATE TYPE "public"."report_status" AS ENUM('generating', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "report" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"minio_key" text NOT NULL,
	"status" "report_status" DEFAULT 'generating' NOT NULL,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report" ADD CONSTRAINT "report_organization_id_organization_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_report_project_created" ON "report" USING btree ("organization_id","project_id","created_at");