-- A small numeric id for a catalog row, for the places that need to name an item as a NUMBER
-- rather than as its `item_key` (a comma-laden `AvatarItemDesc` or a 22-to-36 character guid,
-- neither of which belongs in a URL or a compact index).
--
-- It is a LOAD-ORDER SURROGATE and nothing more. `runx catalog load` assigns it, so it is
-- stable only until the next load: a `--replace` renumbers everything from 1, and a merge
-- renumbers whatever the captures mention. Nothing may store it, reference it across a load,
-- or treat it as an item's identity -- `item_key` is the identity, and it is what the
-- inventory stores. Anything durable that points at a catalog row must point with the key.
--
-- Unique, because a numeric handle that names two rows is useless as a handle. The loader
-- numbers the captures from 10000 upward and pushes anything already in the table but absent
-- from them above that range, so the numbering stays collision-free through a merge as well as
-- a replace.
--
-- It starts at 10000 rather than 1 because a generated storefront lists a row under this very
-- number as its `PurchasableItemId`, and every captured storefront's own ids are 2764 or below.
-- Numbering from 1 would have collided with sf3's head-on, so one id would mean two different
-- items depending on which storefront the client read it from.
--
-- Nullable, because that is the state between "the row exists" and "the load has numbered
-- it": the loader clears the column first so a merge cannot collide with stale numbers, and
-- fills it as it goes. A NULL here after a load means the load did not finish -- the CLI
-- verifies row counts and probe keys for exactly that reason. SQLite treats NULLs as distinct
-- for uniqueness, so any number of un-numbered rows can coexist.
--
-- Its own migration rather than folded into 0015, because 0015 is already applied: an edit
-- there would never re-run on a database that has recorded it.

ALTER TABLE catalog ADD COLUMN catalog_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_id
	ON catalog (catalog_id) WHERE catalog_id IS NOT NULL;
