-- Studio history. Until now Studio was explicitly ephemeral ("Results are
-- ephemeral; nothing is stored", studio/studio.go:4); this table is the first
-- thing to persist a GenerateResult so a finished run can be reopened later.
--
-- Rows are written ONLY on a completed generate (httpapi/studio.go), so there is
-- no 'generating' state and no orphan sweep to run at startup — unlike fanart,
-- which needs FailOrphanedGenerating.
--
-- genres/bands/titles/albums are JSON arrays in a TEXT column, not join tables:
-- they are display-only lists, never queried by element, and four join tables for
-- four never-joined lists costs more than it buys. They default to '[]' rather
-- than NULL so library/studio_history.go can json.Unmarshal unconditionally.
--
-- reference_artist/reference_title are the REAL artist and title as identified by
-- the model during turn-1 research (studio/prompts.go). They are labels for this
-- list and nothing else; they are empty when the model declined to name them, in
-- which case the UI falls back to `reference` verbatim.
--
-- coverart_id references studio_coverart(id) but is deliberately NOT a foreign
-- key: deleting a history row must never cascade into an image that other things
-- may still serve, and a cover generated after the run is attached by UPDATE.
--
-- History is SHARED, not per-user: this is a single-user install in practice, so
-- unlike `favorites` there is no username column.
CREATE TABLE studio_history (
    id               TEXT PRIMARY KEY,
    reference        TEXT NOT NULL,
    reference_artist TEXT NOT NULL DEFAULT '',
    reference_title  TEXT NOT NULL DEFAULT '',
    style_prompt     TEXT NOT NULL,
    lyrics           TEXT NOT NULL,
    cover_art_prompt TEXT NOT NULL,
    genres           TEXT NOT NULL DEFAULT '[]',
    bands            TEXT NOT NULL DEFAULT '[]',
    titles           TEXT NOT NULL DEFAULT '[]',
    albums           TEXT NOT NULL DEFAULT '[]',
    coverart_id      TEXT,
    refine_count     INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No secondary index on purpose. The drawer lists newest-first and pages with a
-- keyset on rowid (WHERE rowid < ? ORDER BY rowid DESC LIMIT ?), which walks this
-- table's own rowid b-tree backwards — already the cheapest plan there is. An
-- index on created_at would serve a different query than the one we run, and
-- SQLite cannot index rowid itself ("no such column: rowid").
