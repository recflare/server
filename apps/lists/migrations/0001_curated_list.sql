-- Player-owned curated lists — the playlists a player builds themselves, of which
-- "Saved for Later" (`__SavedForLater_Rooms`) is the one the client creates on its own and
-- reads back through `GET /curatedlists?creatorAccountId=&type=&name=`. Generated from
-- packages/domain/src/lists-db.ts (CURATED_LIST_SCHEMA_DDL) — keep in sync.
--
-- Until now that endpoint only ever served the static captures in
-- static/curated-lists.json, and a name it had nothing under fell back to the page's
-- default list — so asking for a player's Saved for Later answered the Play/Explore rows.
--
-- A list is GENERIC: `list_type` is the ListEntityType (1 = Rooms), it says what the
-- `item_id`s ARE, and nothing here interprets them — the client resolves each id against
-- the service that type names. Hence `item_id` TEXT: a list of rooms carries room ids, a
-- list of discovery sections carries section keys, and one column holds both.

-- `list_id` is an ordinary autoincrement integer. The reference's own ids run to 18 digits
-- (624765592684307326) and the static captures still carry theirs verbatim, but nothing
-- requires a list this server MINTS to look like that — and a small id stays well inside
-- what a JS number holds exactly, so it cannot be rounded on its way through D1 or JSON.
-- AUTOINCREMENT rather than a bare rowid alias: a list id is handed to the client, so a
-- deleted list's id must not later be handed out again for a different list.
CREATE TABLE IF NOT EXISTS list (
  list_id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_account_id INTEGER NOT NULL,
  list_type INTEGER NOT NULL,
  list_name TEXT NOT NULL,
  list_name_lower TEXT GENERATED ALWAYS AS (lower(list_name)) VIRTUAL,
  list_description TEXT,
  image_name TEXT NOT NULL DEFAULT '',
  accessibility INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
  );

-- The lookup the client actually makes, all three keys at once. UNIQUE because that triple
-- is a list's identity: the client asks for `__SavedForLater_Rooms` by name expecting the
-- one it has been appending to, so a player must never end up with two. Folded, since the
-- casing that reaches us is the client's.
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_owner_type_name
  ON list (creator_account_id, list_type, list_name_lower);
CREATE INDEX IF NOT EXISTS idx_list_creator ON list (creator_account_id);

-- A list's contents. Insertion order is preserved by the surrogate key and is the order the
-- ItemIds array is served in. UNIQUE on the pair: saving the same room twice is a no-op,
-- not a carousel showing it twice.
CREATE TABLE IF NOT EXISTS list_item (
  list_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  item_id TEXT NOT NULL
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_item_pair ON list_item (list_id, item_id);
CREATE INDEX IF NOT EXISTS idx_list_item_list ON list_item (list_id);
