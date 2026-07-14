package library

import (
	"context"
	"database/sql"
	"fmt"
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

// topTenSelect ranks the ten most-played songs, counting only plays from the
// last 30 days so the chart reflects current popularity and older plays never
// influence the order. Ordering is fully deterministic — play count DESC, then
// case-folded title, then id — so ties never depend on row insertion order. The
// 30-day window is always the WHERE clause; %s appends " AND ..." (a published
// filter, or empty) so anonymous viewers never chart an unpublished song.
const topTenSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.lyrics, s.created_at, s.is_published,
	COALESCE(al.status, '') AS alignment_status,
	COUNT(p.id) AS play_count
	FROM songs s JOIN artists a ON a.id = s.artist_id JOIN plays p ON p.song_id = s.id
	LEFT JOIN song_alignment al ON al.song_id = s.id
	WHERE p.played_at >= datetime('now', '-30 days')%s
	GROUP BY s.id
	ORDER BY play_count DESC, lower(s.title) ASC, s.id ASC
	LIMIT 10`

// TopTen returns the ten most-played songs with their play counts.
func (r *Repo) TopTen(ctx context.Context, includeUnpublished bool) ([]TopTenEntry, error) {
	query := fmt.Sprintf(topTenSelect, publishedFilter(includeUnpublished, true))
	rows, err := r.db.QueryContext(ctx, query)
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
	var album, cover, lyrics sql.NullString
	var year, track sql.NullInt64
	var published int64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &lyrics, &s.CreatedAt, &published,
		&s.AlignmentStatus, count); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.CoverArtID = cover.String
	s.Lyrics = lyrics.String
	s.Published = published != 0
	s.Genres = []string{}
	return &s, nil
}
