CREATE TYPE "public"."excel_export_lane" AS ENUM('light', 'clips');--> statement-breakpoint
CREATE TYPE "public"."excel_export_media" AS ENUM('raw', 'images', 'clips');--> statement-breakpoint
CREATE TYPE "public"."excel_export_status" AS ENUM('queued', 'running', 'cancelling', 'cancelled', 'ready', 'ready_with_errors', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "excel_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"owner_user_id" text NOT NULL,
	"types" jsonb NOT NULL,
	"targets" jsonb NOT NULL,
	"media" "excel_export_media" NOT NULL,
	"lane" "excel_export_lane" NOT NULL,
	"status" "excel_export_status" DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"items_total" integer DEFAULT 0 NOT NULL,
	"items_done" integer DEFAULT 0 NOT NULL,
	"bytes_written" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"package_key" text,
	"package_size" bigint,
	"request_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "excel_export" ADD CONSTRAINT "excel_export_organization_id_organization_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excel_export" ADD CONSTRAINT "excel_export_project_id_project_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_excel_export_owner_created" ON "excel_export" USING btree ("organization_id","owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_excel_export_active" ON "excel_export" USING btree ("owner_user_id","request_hash") WHERE "excel_export"."status" IN ('queued', 'running', 'cancelling');--> statement-breakpoint
CREATE INDEX "idx_excel_export_lane_created" ON "excel_export" USING btree ("lane","status","created_at");