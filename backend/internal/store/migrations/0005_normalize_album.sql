-- Album cover propagation keys on albumKey = lower(trim(album)), but songs.album
-- was historically stored raw (nullStr never trimmed) while the bulk-apply matched
-- on lower(album). Real ID3 tags routinely carry trailing spaces / null padding, so
-- a sibling stored as "Album " never matched the trimmed key "album" and silently
-- missed the shared cover — a divergence a page reload could not fix.
--
-- Going forward, writes store a trimmed album and every album match uses
-- lower(trim(album)). This migration heals existing libraries:

-- 1. Trim stored album names so the displayed representative spelling and the
--    (non-unique) idx_songs_album index match the canonical key. Empty-after-trim
--    collapses to NULL, matching normalizeAlbum.
-- `IS NOT` is null-safe, so an all-whitespace album (trim -> '' -> NULL) is not
-- skipped the way `<> NULL` would skip it: it correctly collapses to NULL.
UPDATE songs
   SET album = NULLIF(trim(album), '')
 WHERE album IS NOT NULL
   AND album IS NOT NULLIF(trim(album), '');

-- 2. Re-apply each album's mapped cover to every song of that artist+album. Album
--    tracks share one cover (album_covers is the single owner), so this enforces
--    the invariant for siblings that were skipped while their album was padded.
--    album_covers.album_key is already lower(trim(album)) (written via albumKey).
UPDATE songs
   SET cover_art_id = (
     SELECT ac.cover_art_id FROM album_covers ac
      WHERE ac.artist_id = songs.artist_id
        AND ac.album_key = lower(trim(songs.album)))
 WHERE EXISTS (
     SELECT 1 FROM album_covers ac
      WHERE ac.artist_id = songs.artist_id
        AND ac.album_key = lower(trim(songs.album)));
