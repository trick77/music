package library

import (
	"context"
	"errors"
	"strings"
)

// UpdateSongParams carries the editable fields for a tag edit.
type UpdateSongParams struct {
	Title      string
	ArtistName string
	Album      string
	Year       int
	TrackNo    int
	Genres     []string
	FileSize   int64
}

// Update edits a song's metadata: title/artist(upsert)/album/year/track, replaces
// its genres, refreshes file_size, and re-resolves the album cover for the new
// artist+album (adopting that album's mapped cover when one exists). content_hash
// is deliberately left unchanged — it is the import identity, not a live checksum.
func (r *Repo) Update(ctx context.Context, id string, p UpdateSongParams) (*Song, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	artistID, err := upsertArtist(ctx, tx, p.ArtistName)
	if err != nil {
		return nil, err
	}
	coverID, err := albumCoverIDTx(ctx, tx, artistID, p.Album)
	if err != nil {
		return nil, err
	}

	if coverID != "" {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, file_size=?, cover_art_id=?
			 WHERE id=?`,
			p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo), p.FileSize, coverID, id,
		); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, file_size=?
			 WHERE id=?`,
			p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo), p.FileSize, id,
		); err != nil {
			return nil, err
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM song_genres WHERE song_id=?`, id); err != nil {
		return nil, err
	}
	for i, g := range dedupeGenres(p.Genres) {
		genreID, err := upsertGenre(ctx, tx, g)
		if err != nil {
			return nil, err
		}
		primary := 0
		if i == 0 {
			primary = 1
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO song_genres(song_id, genre_id, is_primary) VALUES(?,?,?)`,
			id, genreID, primary); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// Suggestion is one typeahead candidate with its usage count.
type Suggestion struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// Suggest returns up to 10 existing values for a field matching q (case-
// insensitive substring), most-used first.
func (r *Repo) Suggest(ctx context.Context, field, q string) ([]Suggestion, error) {
	like := "%" + strings.ToLower(strings.TrimSpace(q)) + "%"
	var query string
	switch field {
	case "artist":
		query = `SELECT a.name, COUNT(s.id) c FROM artists a JOIN songs s ON s.artist_id = a.id
			WHERE a.name_key LIKE ? GROUP BY a.id ORDER BY c DESC, a.name LIMIT 10`
	case "album":
		query = `SELECT s.album, COUNT(*) c FROM songs s
			WHERE s.album IS NOT NULL AND s.album != '' AND lower(s.album) LIKE ?
			GROUP BY lower(s.album) ORDER BY c DESC, s.album LIMIT 10`
	case "genre":
		query = `SELECT g.name, COUNT(sg.song_id) c FROM genres g JOIN song_genres sg ON sg.genre_id = g.id
			WHERE lower(g.name) LIKE ? GROUP BY g.id ORDER BY c DESC, g.name LIMIT 10`
	default:
		return nil, errors.New("library: unknown suggest field")
	}
	rows, err := r.db.QueryContext(ctx, query, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Suggestion{}
	for rows.Next() {
		var s Suggestion
		if err := rows.Scan(&s.Value, &s.Count); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
