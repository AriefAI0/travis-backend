ALTER TABLE "recording_ingest" ADD COLUMN "key_prefix" text;--> statement-breakpoint
-- abort when the default org is missing: every row would mislabel as dead/
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization WHERE name = 'default') THEN
    RAISE EXCEPTION 'no organization named default; key_prefix backfill aborted';
  END IF;
END $$;--> statement-breakpoint
-- backfill: each ingest's old numeric directory
-- the chain is a subquery, since an UPDATE's FROM clause
-- cannot reference the target alias in its JOIN ON clauses
-- dead/<ingestId> is a guard: the check constraint makes it unreachable
UPDATE recording_ingest i
SET key_prefix = COALESCE(b.prefix, 'dead/' || i.ingest_id)
FROM (
  SELECT ri.ingest_id,
         COALESCE(p.organization_id, (SELECT organization_id FROM organization WHERE name = 'default' LIMIT 1))::text || '/' ||
         p.project_id || '/' || s.session_id || '/' ||
         to_char(ri.key_date, 'YYYY') || '/' || to_char(ri.key_date, 'MM') || '/' || to_char(ri.key_date, 'DD') || '/' ||
         CASE WHEN ri.kind = 'master' THEN 'master' ELSE 'clips' END || '/' ||
         CASE WHEN ri.kind = 'master' THEN ri.master_video_id ELSE vc.clip_id END AS prefix
  FROM recording_ingest ri
  LEFT JOIN video_clip vc ON ri.kind = 'clip' AND vc.clip_id = ri.clip_id
  LEFT JOIN master_video mv ON mv.master_video_id = COALESCE(ri.master_video_id, vc.master_video_id)
  LEFT JOIN session s ON s.session_id = mv.session_id
  LEFT JOIN project p ON p.project_id = s.project_id
) b
WHERE b.ingest_id = i.ingest_id
  -- idempotent: never clobber a prefix already frozen by admission
  AND i.key_prefix IS NULL;
