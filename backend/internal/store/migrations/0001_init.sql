CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE artists (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE          -- case-folded match key
);

CREATE TABLE cover_art (
    id           TEXT PRIMARY KEY,
    image_path   TEXT NOT NULL,
    width        INTEGER NOT NULL DEFAULT 0,
    height       INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE songs (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album        TEXT,                      -- optional tag
    year         INTEGER,
    track_no     INTEGER,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    file_path    TEXT NOT NULL,             -- managed-store relative path
    file_size    INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    cover_art_id TEXT REFERENCES cover_art(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_songs_artist ON songs(artist_id);
CREATE INDEX idx_songs_album ON songs(artist_id, album);

CREATE TABLE genres (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    accent_color TEXT                         -- auto-sampled from the active background (#rrggbb)
);

CREATE TABLE song_genres (
    song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    genre_id   TEXT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, genre_id)
);
CREATE INDEX idx_song_genres_genre ON song_genres(genre_id);

CREATE TABLE playlists (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    cover_art_id TEXT REFERENCES cover_art(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE playlist_songs (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
);

CREATE TABLE fanart (
    id         TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('hero', 'genre')),
    genre_id   TEXT REFERENCES genres(id) ON DELETE CASCADE,
    caption    TEXT,
    prompt     TEXT,                        -- when generated (server-only, never served to clients)
    model      TEXT,                        -- when generated (server-only, never served to clients)
    seed       INTEGER,                     -- when generated
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
    error      TEXT,                        -- generation failure reason (server-only, auth-gated)
    is_active  INTEGER NOT NULL DEFAULT 0,  -- active background for its genre
    is_hero    INTEGER NOT NULL DEFAULT 0,  -- starred as featured Home hero
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fanart_genre ON fanart(genre_id);

CREATE TABLE plays (
    id        TEXT PRIMARY KEY,
    song_id   TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plays_song ON plays(song_id);
CREATE INDEX idx_plays_at ON plays(played_at);

-- ── Folded from former 0002 (content-hash dedupe) ──────────────────────────
-- Enforce content-hash dedupe for songs that carry a hash (empty hash allowed
-- for legacy/edge rows).
CREATE UNIQUE INDEX idx_songs_content_hash
    ON songs(content_hash) WHERE content_hash != '';

-- ── Folded from former 0003 (artist+album -> cover mapping, spec §7) ────────
-- Durable artist+album -> cover mapping so cover art auto-applies to every
-- existing AND future song sharing that artist+album. Singles (no album) use
-- per-song songs.cover_art_id instead.
CREATE TABLE album_covers (
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album_key    TEXT NOT NULL,                 -- lower(album)
    cover_art_id TEXT NOT NULL REFERENCES cover_art(id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, album_key)
);

-- ── Phase 4: fast ordered reads of a playlist's tracks ─────────────────────
-- playlist_songs' PRIMARY KEY is (playlist_id, song_id); this index serves
-- ORDER BY position for a playlist. position is NOT unique (ties are allowed
-- and resolved by the reorder rewrite).
CREATE INDEX idx_playlist_songs_order ON playlist_songs(playlist_id, position);
