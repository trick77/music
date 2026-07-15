package library

import (
	"context"
	"database/sql"
)

// SongStats is one song's playback history, for the tag editor's Info tab.
//
// Counts are LIFETIME, deliberately unlike TopTen's rolling 30-day window: the
// chart wants current popularity, but a single song's own stats should mean what
// they say — "248 plays" is 248 plays ever. Don't unify the two queries.
type SongStats struct {
	Plays int `json:"plays"`
	// LastPlayedAt is the SQLite datetime of the most recent play, or "" when the
	// song has never been played. Same wire shape as Song.CreatedAt.
	LastPlayedAt string `json:"lastPlayedAt"`
}

// SongStats returns lifetime play figures for songID. A song nobody has played
// is not an error — it yields a zero count and an empty timestamp. idx_plays_song
// is on (song_id) alone, so it serves the filter and MAX(played_at) then scans the
// matched rows; fine at plays-per-song scale. Widen the index to (song_id,
// played_at) if that ever stops being true.
func (r *Repo) SongStats(ctx context.Context, songID string) (*SongStats, error) {
	var stats SongStats
	var last sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*), MAX(played_at) FROM plays WHERE song_id = ?`, songID).
		Scan(&stats.Plays, &last)
	if err != nil {
		return nil, err
	}
	stats.LastPlayedAt = last.String // NULL (never played) → ""
	return &stats, nil
}
