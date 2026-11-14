-- Exclusive access links for DJs and readers (portaria). The link is an HMAC over this nonce,
-- so regenerating the nonce revokes the previous link.
ALTER TABLE event_djs ADD COLUMN IF NOT EXISTS access_nonce varchar(64);
ALTER TABLE event_readers ADD COLUMN IF NOT EXISTS access_nonce varchar(64);
