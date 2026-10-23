CREATE TYPE "public"."gvi_cp_method" AS ENUM('contact', 'proximity');--> statement-breakpoint
ALTER TYPE "public"."datasheet_kind" ADD VALUE 'UT';--> statement-breakpoint
ALTER TABLE "part_code" ADD COLUMN "nominal_wall_mm" double precision;--> statement-breakpoint
ALTER TABLE "result_gvi_finding" ADD COLUMN "cp_method" "gvi_cp_method";--> statement-breakpoint
ALTER TABLE "result_gvi" DROP COLUMN "kp_range";--> statement-breakpoint
ALTER TABLE "result_gvi" DROP COLUMN "gvi_ut";