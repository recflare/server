-- A room offer's `Version`: 1 on create, +1 on every replace. Owned by the `econ` worker;
-- generated from src/room-offer-db.ts (ROOM_OFFER_SCHEMA_DDL, which mirrors the table as it
-- stands AFTER this migration) — keep in sync.
--
-- The client's `RoomOfferDTO` carries it (`GET /econ/roomOffer/room/{roomId}`) and sends it
-- back as the purchase's `ExpectedRoomOfferVersion`. Existing offers start at 1.
ALTER TABLE room_offer ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
