-- Idempotent database objects that Prisma's schema language cannot express.
-- Applied by `pnpm db:sync` in development and included in the initial migration for production.

-- 1) Published scenario versions are immutable snapshots: block every UPDATE.
CREATE OR REPLACE FUNCTION cf_prevent_scenario_version_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ScenarioVersion % is immutable; publish a new version instead', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cf_scenario_version_immutable ON "ScenarioVersion";
CREATE TRIGGER cf_scenario_version_immutable
  BEFORE UPDATE ON "ScenarioVersion"
  FOR EACH ROW EXECUTE FUNCTION cf_prevent_scenario_version_update();

-- 2) Full-text search column for knowledge chunks (generated, GIN-indexed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'KnowledgeChunk' AND column_name = 'tsv' AND is_generated = 'NEVER'
  ) THEN
    ALTER TABLE "KnowledgeChunk" DROP COLUMN "tsv";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'KnowledgeChunk' AND column_name = 'tsv'
  ) THEN
    ALTER TABLE "KnowledgeChunk" ADD COLUMN "tsv" tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce("heading", '') || ' ' || "text")) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");

-- 3) Transcript turns are append-only per session sequence (dedupe enforced by unique indexes).
