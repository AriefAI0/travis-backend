-- Drop the legacy asset/component/item structure. The task tree replaced it and
-- v2 results carry their own target ids, so the item chain and the denormalized
-- item columns are dead weight.
--
-- Order matters twice: result first (it references session_item and the old
-- tree), and the target check is dropped BEFORE its columns, because dropping
-- session_item_id would take the constraint with it.
ALTER TABLE "result" DROP CONSTRAINT "result_session_item_id_session_item_session_item_id_fk";--> statement-breakpoint
ALTER TABLE "result" DROP CONSTRAINT "result_target_check";--> statement-breakpoint
ALTER TABLE "result" DROP COLUMN "session_item_id";--> statement-breakpoint
ALTER TABLE "result" DROP COLUMN "asset_id";--> statement-breakpoint
ALTER TABLE "result" DROP COLUMN "component_id";--> statement-breakpoint
ALTER TABLE "result" DROP COLUMN "item_id";--> statement-breakpoint
-- every remaining row is a v2 row, so the target pair is now strictly one-of
ALTER TABLE "result" ADD CONSTRAINT "result_target_check" CHECK (num_nonnulls("main_component_id", "component_code_id") = 1);--> statement-breakpoint
DROP TABLE IF EXISTS "session_item";--> statement-breakpoint
DROP TABLE IF EXISTS "item";--> statement-breakpoint
DROP TABLE IF EXISTS "component";--> statement-breakpoint
DROP TABLE IF EXISTS "asset";--> statement-breakpoint
DROP TYPE IF EXISTS "item_status";
