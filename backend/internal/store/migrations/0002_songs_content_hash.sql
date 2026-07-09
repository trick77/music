-- Enforce content-hash dedupe for songs that carry a hash (empty hash allowed
-- for legacy/edge rows). 0001 is already applied and must never be edited.
CREATE UNIQUE INDEX idx_songs_content_hash
    ON songs(content_hash) WHERE content_hash != '';
