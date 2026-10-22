CREATE TYPE "public"."datasheet_kind" AS ENUM('GVI', 'CP_ANODE', 'CP_MEMBER', 'FMD', 'SCOUR', 'DVI');--> statement-breakpoint
CREATE TYPE "public"."datasheet_status" AS ENUM('generating', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "datasheet_report" (
	"datasheet_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"kind" "datasheet_kind" NOT NULL,
	"name" text NOT NULL,
	"targets" jsonb NOT NULL,
	"status" "datasheet_status" DEFAULT 'generating' NOT NULL,
	"error_detail" text,
	"docx_key" text NOT NULL,
	"pdf_key" text,
	"pdf_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "datasheet_report" ADD CONSTRAINT "datasheet_report_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datasheet_report" ADD CONSTRAINT "datasheet_report_organization_id_organization_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_datasheet_project_created" ON "datasheet_report" USING btree ("organization_id","project_id","created_at");