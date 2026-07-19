-- Track "N of Y" numbering. track_no already exists; add the total-tracks
-- companion. NULL means "not part of a numbered album" (a single, or an empty
-- album) — the same convention track_no uses.
ALTER TABLE songs ADD COLUMN track_total INTEGER;

-- One-off backfill: every artist+album group is numbered by add order (rowid),
-- overwriting any tag-derived track_no, so existing combinations get consistent
-- "N of Y" fields. Songs with an empty/blank album are singles and left untouched.
-- Album grouping mirrors albumKey()/ListAlbums: lower(trim(album)) per artist.
-- rn is a running sequence (needs ORDER BY); cnt is the whole-partition total, so
-- it uses a PARTITION-only window — an ORDER BY window would count only up to the
-- current row (a running total), not the group size.
UPDATE songs SET track_no = sub.rn, track_total = sub.cnt
FROM (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY artist_id, lower(trim(album)) ORDER BY rowid) AS rn,
    COUNT(*)     OVER (PARTITION BY artist_id, lower(trim(album)))                AS cnt
  FROM songs
  WHERE album IS NOT NULL AND trim(album) != ''
) sub
WHERE songs.id = sub.id;
