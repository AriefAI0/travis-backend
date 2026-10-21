ALTER TYPE "public"."pi_finding_category" ADD VALUE 'anode';--> statement-breakpoint
ALTER TABLE "result_pipeline_finding" ADD COLUMN "anode_cp_value" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_pipeline_finding" ADD COLUMN "anode_depletion" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_pipeline_finding" ADD COLUMN "anode_kp" text DEFAULT '' NOT NULL;