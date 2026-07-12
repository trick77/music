package library

import (
	"context"
	"database/sql"
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
	Lyrics     string
	FileSize   int64
}

// Update edits a song's metadata: title/artist(upsert)/album/year/track, replaces
// its genres, refreshes file_size, and keeps the album cover in sync for the new
// artist+album. If that album already has a mapped cover the song adopts it;
// otherwise the song's own cover (if any) is registered as the album's cover so
// every song sharing that artist+album stays on the same art. content_hash is
// deliberately left unchanged — it is the import identity, not a live checksum.
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

	// Remember the song's current cover before the edit so it can seed a new
	// album mapping when we move it into an album that has none yet.
	var curCover sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT cover_art_id FROM songs WHERE id=?`, id).Scan(&curCover); err != nil {
		return nil, err
	}

	// The main row edit deliberately leaves cover_art_id untouched; the album
	// cover reconciliation below is the single owner of that column.
	if _, err := tx.ExecContext(ctx,
		`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, lyrics=?, file_size=?
		 WHERE id=?`,
		p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo), nullStr(p.Lyrics), p.FileSize, id,
	); err != nil {
		return nil, err
	}

	// Reconcile the album cover for the new artist+album. Albums keep a single
	// shared cover (album_covers); singles keep their per-song cover as-is.
	if key := albumKey(p.Album); key != "" {
		cover, err := albumCoverIDTx(ctx, tx, artistID, p.Album)
		if err != nil {
			return nil, err
		}
		if cover == "" {
			cover = curCover.String // no album cover yet: adopt this song's own
		}
		if cover != "" {
			// Upserts the mapping and applies it to every song of the album,
			// including this one (its album/artist were just updated above).
			if err := setAlbumCoverTx(ctx, tx, artistID, key, cover); err != nil {
				return nil, err
			}
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

// SetPublished flips a song's publish state and returns the updated song, or
// (nil,nil) if the id is unknown. Uploads land unpublished; this is the only way
// to publish (or later unpublish) a song. The read model passed to authenticated
// callers is returned so the UI can reflect the new state immediately.
func (r *Repo) SetPublished(ctx context.Context, id string, published bool) (*Song, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE songs SET is_published = ? WHERE id = ?`, boolToInt(published), id)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil {
		return nil, err
	} else if n == 0 {
		return nil, nil
	}
	return r.Get(ctx, id)
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ErrUnknownSuggestField is returned by Suggest for an unsupported field, so the
// handler can distinguish a bad request from a database failure.
var ErrUnknownSuggestField = errors.New("library: unknown suggest field")

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
		return nil, ErrUnknownSuggestField
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
