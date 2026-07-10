-- Durable artist+album -> cover mapping so cover art auto-applies to every
-- existing AND future song sharing that artist+album (spec §7). Singles (no
-- album) use per-song songs.cover_art_id instead. 0001/0002 stay untouched.
CREATE TABLE album_covers (
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album_key    TEXT NOT NULL,                 -- lower(album)
    cover_art_id TEXT NOT NULL REFERENCES cover_art(id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, album_key)
);
