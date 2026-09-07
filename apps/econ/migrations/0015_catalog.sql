-- The item catalog: every avatar item and every equipment skin the game knows about.
--
-- STRUCTURE ONLY. This migration holds no rows: the catalog's CONTENTS are loaded by
-- `runx catalog load [--remote]` from apps/econ/static/db/avatar-items.json and
-- apps/econ/static/db/skins.json.
--
-- That split is deliberate. The item list changes as the game's does, and that is not a
-- schema change -- putting rows here would mean a migration and a deploy per refresh, an
-- ever-growing pile of near-identical data migrations, and no way to reload without writing
-- another one. Versioning the structure and reloading the contents on demand also makes a
-- refresh a readable `git diff` of the JSON rather than of 700KB of generated SQL.
--
-- ONE KEY spans both kinds: `item_key` is an avatar item's `AvatarItemDesc` and a skin's
-- `ModificationGuid`. Neither repeats, the two never collide, and no item has both -- so the
-- catalog is keyed the same way the INVENTORY is, and resolving what a player owns is a
-- lookup on this column rather than a join keyed on which kind of thing it turned out to be.
--
-- Not every key is a GUID: 191 skins and 109 avatar items carry the short alpha-string ids
-- the game used before it moved to GUIDs. The column is TEXT and compared as text; do not add
-- a uuid-shaped constraint, and do not try to parse one.
--
-- `avatar_item_id` is carried as DATA ONLY and is deliberately not indexed. It cannot key
-- anything: it is missing from 22 avatar items (the permanent hair dyes have no id at all)
-- and repeated on 9 more -- id 9503 alone is shared by five unrelated developer items.
--
-- `tooltip` is deliberately nullable, on both kinds: the capture carries NULL and "" as
-- different values and the client's DTOs serve the difference through. Do not default it.
--
-- `Favorited` from skins.json is NOT loaded: it is a player's flag, not a property of the
-- skin, and the capture recorded one account's. It is projected as false and overwritten
-- from the player's own `equipment` row -- see src/catalog-db.ts.

CREATE TABLE IF NOT EXISTS catalog (
	item_key TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	friendly_name TEXT NOT NULL,
	tooltip TEXT,
	rarity INTEGER NOT NULL DEFAULT 0,
	platform_mask INTEGER NOT NULL DEFAULT -1,
	thumbnail_image TEXT,
	avatar_item_type INTEGER,
	avatar_item_id INTEGER,
	is_base_avatar_item INTEGER,
	tag_list TEXT,
	created_at TEXT,
	prefab_name TEXT,
	unlocked_level INTEGER
);

-- The search index. Folded, because a name search is case-insensitive and SQLite's LIKE only
-- folds ASCII -- which these names are not all of.
CREATE INDEX IF NOT EXISTS idx_catalog_name ON catalog (kind, lower(friendly_name));

-- Every skin of one prefab, which is how a skin picker is filled.
CREATE INDEX IF NOT EXISTS idx_catalog_prefab
	ON catalog (prefab_name) WHERE prefab_name IS NOT NULL;

-- Seasonal rows ('halloween', 'music', ...): a handful of tags over 3000-odd rows.
CREATE INDEX IF NOT EXISTS idx_catalog_tag ON catalog (tag_list) WHERE tag_list IS NOT NULL;
