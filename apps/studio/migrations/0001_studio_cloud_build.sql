-- Local Rec Room Studio builds. The editor builds Windows and Android asset bundles
-- on the creator's PC and posts them here; each post is one finished cloud build
-- attached to the subroom's current save. Bundle bytes live in the shared
-- `recflare-cdn` bucket under `studio-room-bundles/`. This worker owns the tables.
-- Generated from apps/studio/src/local-builds.ts — keep in sync.

CREATE TABLE IF NOT EXISTS studio_cloud_build (
  cloud_build_id TEXT PRIMARY KEY,
  room_id INTEGER NOT NULL,
  sub_room_id INTEGER NOT NULL,
  sub_room_data_save_id INTEGER NOT NULL,
  unity_asset_id TEXT NOT NULL,
  created_by_account_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_studio_cloud_build_room
  ON studio_cloud_build (room_id, sub_room_id, started_at);

CREATE TABLE IF NOT EXISTS studio_unity_asset_file (
  unity_asset_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  PRIMARY KEY (unity_asset_id, platform, kind)
);
