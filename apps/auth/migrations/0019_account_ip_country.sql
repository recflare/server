-- The country Cloudflare places each address in (`request.cf.country`, ISO 3166-1 alpha-2;
-- `T1` for Tor), as of the most recent grant from it — geolocation of an address can move,
-- and the latest reading is the useful one. NULL for rows recorded before this column, and
-- for a grant the edge couldn't place. Mirrored in @repo/domain's ACCOUNT_IP_SCHEMA_DDL.

ALTER TABLE account_ip ADD COLUMN country TEXT;
