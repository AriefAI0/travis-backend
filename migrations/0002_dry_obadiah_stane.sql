CREATE TYPE "public"."report_scope" AS ENUM('all', 'anomaly');--> statement-breakpoint
ALTER TABLE "report" ADD COLUMN "scope" "report_scope" DEFAULT 'all' NOT NULL;