-- Genre names are canonicalized to lowercase; the UI title-cases them for display.
-- Historically a name was stored first-seen-case, and the rename path
-- (UpdateGenreName) did a raw UPDATE with no case check, so case-duplicate rows
-- ("Rock" and "rock") can exist. Lowercasing naively would collide on the
-- UNIQUE(name) constraint and roll the migration back (app won't boot), so we
-- merge duplicates first. Genre ids are random (not name-derived), so ids are
-- stable — only merged-away rows change their associations.
--
-- Survivor of each case-variant set = the row with the smallest id.
-- Foreign keys are enforced during migration, so re-point children before
-- deleting parents.

-- 1. Lift is_primary onto the survivor's song row while every variant still
--    exists: if any case-variant of a genre is primary for a song, the survivor
--    row must be primary. (INSERT/UPDATE OR IGNORE below would otherwise keep only
--    the survivor's own pre-existing flag.)
UPDATE song_genres
   SET is_primary = 1
 WHERE genre_id IN (SELECT MIN(id) FROM genres GROUP BY lower(name))
   AND EXISTS (
     SELECT 1 FROM song_genres l
       JOIN genres lg ON lg.id = l.genre_id
       JOIN genres s  ON s.id  = song_genres.genre_id
      WHERE l.song_id = song_genres.song_id
        AND lower(lg.name) = lower(s.name)
        AND l.is_primary = 1
   );

-- 2. Re-point song_genres from losers to the survivor. OR IGNORE skips rows that
--    would duplicate the (song_id, genre_id) primary key (song already linked to
--    the survivor); those redundant loser rows are cleaned up by the cascade in
--    step 4.
UPDATE OR IGNORE song_genres
   SET genre_id = (
     SELECT MIN(g2.id) FROM genres g2
      WHERE lower(g2.name) = lower((SELECT name FROM genres g1 WHERE g1.id = song_genres.genre_id))
   );

-- 3. Re-point fanart from losers to the survivor.
UPDATE fanart
   SET genre_id = (
     SELECT MIN(g2.id) FROM genres g2
      WHERE lower(g2.name) = lower((SELECT name FROM genres g1 WHERE g1.id = fanart.genre_id))
   )
 WHERE genre_id IS NOT NULL;

-- 4. Delete the loser genres. ON DELETE CASCADE removes any redundant
--    song_genres/fanart rows still pointing at them (the ones OR IGNORE skipped).
DELETE FROM genres
 WHERE id NOT IN (SELECT MIN(id) FROM genres GROUP BY lower(name));

-- 5. Canonicalize the surviving names to trimmed lowercase.
UPDATE genres SET name = lower(trim(name));
