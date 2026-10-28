-- Scope routine execution issues to the schedule slot that produced them.
--
-- "issues_open_routine_execution_uq" keyed only on (company, origin kind, origin
-- id, origin fingerprint). The dispatch fingerprint is derived from the
-- resolved payload/title/description, so a routine with several triggers and no
-- per-slot variables hashed every slot to the SAME fingerprint. The unique
-- index therefore made the whole routine a single execution slot: an open
-- wrapper for one trigger blocked the next trigger's issue from ever existing.
--
-- The slot columns record which trigger and which cron occurrence an execution
-- issue belongs to, and the index adds the coalesced slot key so:
--   * two different slots of the same routine can hold open execution issues
--     concurrently, and
--   * legacy rows (slot key NULL) all collapse into the 'default' bucket and
--     keep excluding each other exactly as before.
--
-- "routine_runs.slot_key" is the durable per-run slot trace: a skipped trigger
-- records the slot it belonged to so "the trigger was suppressed" stays
-- queryable next to "the run failed".
DROP INDEX "issues_open_routine_execution_uq";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "origin_slot_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "origin_trigger_id" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "slot_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint",coalesce("origin_slot_key", 'default')) WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');