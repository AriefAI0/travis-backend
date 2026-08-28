ALTER TABLE "result_image" ADD COLUMN "content_type" text DEFAULT 'image/png' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_image" ADD COLUMN "has_annotated" boolean DEFAULT false NOT NULL;