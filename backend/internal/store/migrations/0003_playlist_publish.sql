-- Playlists gain the same publish gate as songs: a newly created playlist lands
-- unpublished (0) and is visible only to logged-in users until published. New
-- playlists take the column default (CreatePlaylist omits is_published); any
-- playlist already present is backfilled to published so nothing disappears for
-- anonymous viewers on upgrade.
ALTER TABLE playlists ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0;
UPDATE playlists SET is_published = 1;
CREATE INDEX idx_playlists_published ON playlists(is_published);
