-- Word-level lyric timings produced by the alignment sidecar. One row per song;
-- re-running an alignment replaces the row. Mirrors the fanart status/error shape.
CREATE TABLE song_alignment (
    song_id    TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating','ready','failed')),
    error      TEXT,                       -- server-only failure reason
    engine     TEXT,                       -- e.g. 'whisperx-3.x+demucs'
    data       TEXT,                       -- JSON: [{text,start,end,words:[{w,start,end,conf}]}]
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
