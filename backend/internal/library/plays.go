package library

import (
	"context"
	"database/sql"
)

// TopTenEntry is a song with its global play count for the chart.
type TopTenEntry struct {
	Song
	Plays int `json:"plays"`
}

// RecordPlay appends one qualified-play row for songID. It validates the song
// exists first so a bogus id can't create an orphan/counted row (returns
// sql.ErrNoRows for an unknown song).
func (r *Repo) RecordPlay(ctx context.Context, songID string) error {
	var exists string
	if err := r.db.QueryRowContext(ctx, `SELECT id FROM songs WHERE id = ?`, songID).Scan(&exists); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO plays(id, song_id) VALUES(?, ?)`, NewID(), songID)
	return err
}

// topTenSelect ranks the ten most-played songs. Ordering is fully deterministic
// — play count DESC, then case-folded title, then id — so ties never depend on
// row insertion order.
const topTenSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.created_at,
	COUNT(p.id) AS play_count
	FROM songs s JOIN artists a ON a.id = s.artist_id JOIN plays p ON p.song_id = s.id
	GROUP BY s.id
	ORDER BY play_count DESC, lower(s.title) ASC, s.id ASC
	LIMIT 10`

// TopTen returns the ten most-played songs with their play counts.
func (r *Repo) TopTen(ctx context.Context) ([]TopTenEntry, error) {
	rows, err := r.db.QueryContext(ctx, topTenSelect)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopTenEntry{}
	for rows.Next() {
		var e TopTenEntry
		s, err := scanSongWithCount(rows, &e.Plays)
		if err != nil {
			return nil, err
		}
		e.Song = *s
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		g, err := r.genresFor(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Genres = g
	}
	return out, nil
}

// scanSongWithCount scans the standard song columns plus a trailing count.
func scanSongWithCount(row scanner, count *int) (*Song, error) {
	var s Song
	var album, cover sql.NullString
	var year, track sql.NullInt64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &s.CreatedAt, count); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.CoverArtID = cover.String
	s.Genres = []string{}
	return &s, nil
}
