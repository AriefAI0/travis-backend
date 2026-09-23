-- Inspection FK delete actions: RESTRICT blocks deleting a project (or a tree
-- node) that has results, because Postgres may remove the target rows before the
-- result rows in the same cascade. Cascade matches the legacy model
-- (item > session_item > result) and keeps project deletion working.
-- The "type in use" and "form in use" rules stay service-level 409s.
ALTER TABLE "main_component_type" DROP CONSTRAINT "main_component_type_component_type_id_fkey";--> statement-breakpoint
ALTER TABLE "main_component_type" ADD CONSTRAINT "main_component_type_component_type_id_fkey" FOREIGN KEY ("component_type_id") REFERENCES "component_type"("component_type_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "result" DROP CONSTRAINT "result_main_component_id_main_component_id_fk";--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_main_component_id_main_component_id_fk" FOREIGN KEY ("main_component_id") REFERENCES "main_component"("main_component_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "result" DROP CONSTRAINT "result_component_code_id_component_code_id_fk";--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_component_code_id_component_code_id_fk" FOREIGN KEY ("component_code_id") REFERENCES "component_code"("component_code_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "result" DROP CONSTRAINT "result_inspection_form_id_inspection_form_id_fk";--> statement-breakpoint
ALTER TABLE "result" ADD CONSTRAINT "result_inspection_form_id_inspection_form_id_fk" FOREIGN KEY ("inspection_form_id") REFERENCES "inspection_form"("inspection_form_id") ON DELETE cascade;
