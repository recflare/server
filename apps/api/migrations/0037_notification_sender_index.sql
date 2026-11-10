-- The message send's burst limit counts one sender's recent rows by `sent_time`; without
-- this the count scans the whole table on every send.
CREATE INDEX IF NOT EXISTS idx_notification_sender ON notification (from_player_id, sent_time);
