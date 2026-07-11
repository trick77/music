-- Songs gain a publish gate: a freshly uploaded song lands unpublished (0) and
-- is visible only to logged-in users until published. New uploads take the
-- column default (the INSERT omits is_published); any song already in the
-- library is backfilled to published so nothing disappears for anonymous
-- viewers on upgrade.
ALTER TABLE songs ADD COLUMN is_published INTEGER NOT NULL DEFAULT 0;
UPDATE songs SET is_published = 1;
CREATE INDEX idx_songs_published ON songs(is_published);
