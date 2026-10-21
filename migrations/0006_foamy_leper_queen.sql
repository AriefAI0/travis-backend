CREATE TYPE "public"."scour_yes_no" AS ENUM('yes', 'no');--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "location_leg1" text NOT NULL;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "location_leg2" text NOT NULL;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "dim_a" double precision;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "dim_b" double precision;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "dim_c" double precision;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "exp_leg1" "scour_yes_no" DEFAULT 'no' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "exp_leg2" "scour_yes_no" DEFAULT 'no' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "height_exp_leg1" double precision;--> statement-breakpoint
ALTER TABLE "result_scour" ADD COLUMN "height_exp_leg2" double precision;--> statement-breakpoint
ALTER TABLE "result_scour" DROP COLUMN "exposed_pile";--> statement-breakpoint
ALTER TABLE "result_scour" DROP COLUMN "exposed_pile_height";--> statement-breakpoint
ALTER TABLE "result_scour" DROP COLUMN "height_leg1";--> statement-breakpoint
ALTER TABLE "result_scour" DROP COLUMN "height_midpoint";--> statement-breakpoint
ALTER TABLE "result_scour" DROP COLUMN "height_leg2";--> statement-breakpoint
DROP TYPE "public"."scour_exposed_pile";