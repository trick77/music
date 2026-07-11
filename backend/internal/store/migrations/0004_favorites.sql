-- Per-user favorited songs, for logged-in users only. Anonymous users keep
-- favorites in browser localStorage and never write here; logged-in users
-- persist favorites keyed by session username (there is no users table, so the
-- username string is the owner). Deleting a song cascades to its favorite rows.
-- PRIMARY KEY (username, song_id) already indexes username as its leftmost
-- prefix, which serves the only query shape (WHERE username = ?), so no
-- separate index on username is needed.
CREATE TABLE favorites (
    username   TEXT NOT NULL,
    song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (username, song_id)
);
