CREATE TABLE "result_ci_gvi_associated_pipe" (
	"pipe_id" serial PRIMARY KEY NOT NULL,
	"result_id" integer NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "result_ci" ADD COLUMN "associated_pipes_recommendation" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "result_gvi" ADD COLUMN "kp_range" text;--> statement-breakpoint
ALTER TABLE "result_gvi" ADD COLUMN "gvi_ut" double precision;--> statement-breakpoint
ALTER TABLE "result_ci_gvi_associated_pipe" ADD CONSTRAINT "result_ci_gvi_associated_pipe_result_id_result_ci_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."result_ci"("result_id") ON DELETE cascade ON UPDATE no action;