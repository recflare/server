-- Who is tagged in which photo — one row per (player, image), so a player's "tagged in"
-- photos (`api`: /api/images/v3/feed/player/:id) are an index lookup instead of a
-- json_each scan over every image's TaggedPlayerIds. The blob's TaggedPlayerIds stays the
-- record (the raw SavedImage serves it); triggers keep this table in step with it, so no
-- writer has to. Tags are only set on upload, so there is no UPDATE trigger.
-- Generated from src/images-db.ts (SCHEMA_DDL) — keep in sync.

CREATE TABLE IF NOT EXISTS image_tag (
  player_id INTEGER NOT NULL,
  saved_image_id INTEGER NOT NULL,
  PRIMARY KEY (player_id, saved_image_id)
  ) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_image_tag_image ON image_tag (saved_image_id);

CREATE TRIGGER IF NOT EXISTS image_tag_after_insert AFTER INSERT ON image BEGIN
  INSERT OR IGNORE INTO image_tag (player_id, saved_image_id)
  SELECT value, NEW.id FROM json_each(NEW.data, '$.TaggedPlayerIds') WHERE value IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS image_tag_after_delete AFTER DELETE ON image BEGIN
  DELETE FROM image_tag WHERE saved_image_id = OLD.id;
END;

-- Backfill the photos uploaded before this table existed.
INSERT OR IGNORE INTO image_tag (player_id, saved_image_id)
SELECT j.value, image.id FROM image, json_each(image.data, '$.TaggedPlayerIds') j
WHERE j.value IS NOT NULL AND image.id IS NOT NULL;
