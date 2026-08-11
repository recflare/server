-- Break the two visibility flags out of the invention JSON blob into queryable
-- generated columns, the same way 0003 did for `IsFeatured`. `IsPublished` and
-- `HideFromPlayer` are always tested together — every feed, the search/browse list and
-- the per-room list ask for "published and not hidden" — so they move together.
-- Generated from src/inventions-db.ts (SCHEMA_DDL) — keep in sync.
--
-- SQLite allows ALTER TABLE ADD COLUMN only for VIRTUAL generated columns (a STORED one
-- would need rewriting existing rows), which is what we want anyway: the value stays
-- derived from `data`, so nothing can drift out of sync with it. json_extract of a JSON
-- `true` is 1, so both columns read 1/0 — and NULL for a blob missing the key, which is
-- neither 1 nor 0 and so fails both filters exactly as the json_extract predicates it
-- replaces did. This is a rename, not a behaviour change.
--
-- No index: both columns are booleans that are overwhelmingly one value (nearly every
-- invention is published and not hidden), so an index on them would be read past rather
-- than used. The selective one is idx_invention_featured, added in 0003, which stays.

ALTER TABLE invention
  ADD COLUMN is_published INTEGER GENERATED ALWAYS AS (json_extract(data, '$.IsPublished')) VIRTUAL;
ALTER TABLE invention
  ADD COLUMN hide_from_player INTEGER GENERATED ALWAYS AS (json_extract(data, '$.HideFromPlayer')) VIRTUAL;
