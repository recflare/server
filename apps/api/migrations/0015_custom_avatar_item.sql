-- Custom avatar items (the player-designed shirts/hats built on a base catalog item).
-- Owned by the `api` worker: `POST /api/customAvatarItems/v1` inserts a row. Generated
-- from src/custom-avatar-items-db.ts (SCHEMA_DDL) — keep in sync.
--
-- One column per field of the client's `CustomAvatarItem` DTO, so a row IS the response.
-- The two uploads (the design and the thumbnail PNG) live in the `recflare-img` bucket
-- under `avatar-item/<date>/<id>-thumb.png` / `<id>-design.png`; the filename columns
-- hold those bucket keys.
--
-- `ranking_context` and `purchase_info` are served as null and `current_saves` as an
-- empty list; none of them has a source yet, so they are not columns.

CREATE TABLE IF NOT EXISTS custom_avatar_item (
  custom_avatar_item_id TEXT PRIMARY KEY,
  creator_account_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  accessibility INTEGER NOT NULL DEFAULT 0,
  force_cannot_publish INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_rec_room_approved INTEGER NOT NULL DEFAULT 0,
  base_avatar_item_id INTEGER NOT NULL,
  base_avatar_item_color TEXT NOT NULL,
  design_filename TEXT NOT NULL,
  thumbnail_image_filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  preview_orientation INTEGER NOT NULL DEFAULT 0,
  outfit_type INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX IF NOT EXISTS idx_custom_avatar_item_creator ON custom_avatar_item (creator_account_id);
