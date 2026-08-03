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

	// A tag edit is the user typing the name, so a spelling fix that folds to the
	// same name_key ("SIngers" -> "Singers") updates the artist rather than being
	// silently dropped. artists.name is shared, so the fix lands library-wide.
	artistID, err := upsertArtist(ctx, tx, p.ArtistName, true)
	if err != nil {
		return nil, err
	}

	// Remember the song's current cover before the edit so it can seed a new
	// album mapping when we move it into an album that has none yet. Also remember
	// its current artist+album: if the edit moves the song out of that group, the
	// old group must be renumbered too, not just the new one.
	var curCover, oldAlbum sql.NullString
	var oldArtistID string
	if err := tx.QueryRowContext(ctx, `SELECT cover_art_id, artist_id, album FROM songs WHERE id=?`, id).Scan(&curCover, &oldArtistID, &oldAlbum); err != nil {
		return nil, err
	}

	// The main row edit deliberately leaves cover_art_id untouched; the album
	// cover reconciliation below is the single owner of that column.
	if _, err := tx.ExecContext(ctx,
		`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, lyrics=?, file_size=?
		 WHERE id=?`,
		p.Title, artistID, normalizeAlbum(p.Album), nullInt(p.Year), nullInt(p.TrackNo), nullStr(p.Lyrics), p.FileSize, id,
	); err != nil {
		return nil, err
	}

	// Reconcile the album cover for the new artist+album. Albums keep a single
	// shared cover (album_covers); singles keep their per-song cover as-is.
	if key := albumKey(p.Album); key != "" {
		mapped, err := albumCoverIDTx(ctx, tx, artistID, key)
		if err != nil {
			return nil, err
		}
		switch {
		case mapped != "":
			// The album already has a shared cover: this song just adopts it.
			if _, err := tx.ExecContext(ctx, `UPDATE songs SET cover_art_id=? WHERE id=?`, mapped, id); err != nil {
				return nil, err
			}
		case curCover.Valid && curCover.String != "":
			// The album has no cover yet but this song carries one: register it
			// for the whole artist+album so siblings and future songs share it.
			if err := setAlbumCoverTx(ctx, tx, artistID, key, curCover.String); err != nil {
				return nil, err
			}
		}
	}

	// Renumber the group the song now belongs to, and — only when the edit actually
	// moved it to a different artist+album — the group it left, which just shrank.
	// The guard guarantees the two groups are distinct partitions, so the order of
	// the two passes never matters.
	if oldKey := albumKey(oldAlbum.String); oldKey != albumKey(p.Album) || oldArtistID != artistID {
		if err := renumberAlbumTx(ctx, tx, oldArtistID, oldKey); err != nil {
			return nil, err
		}
	}
	if err := renumberAlbumTx(ctx, tx, artistID, albumKey(p.Album)); err != nil {
		return nil, err
	}
	// Moving a song OUT of an album into no-album makes it a single, which is never
	// numbered. The new-group renumber above is a no-op for an empty key, so clear
	// the stale album numbering explicitly (the read-only track field the editor
	// echoed back is the old album position, not a real single track number).
	if albumKey(p.Album) == "" && albumKey(oldAlbum.String) != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE songs SET track_no = NULL, track_total = NULL WHERE id=?`, id); err != nil {
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
//
// Genres rank prefix matches ahead of the merely-containing ones, because the tag
// editor completes a genre inline as you type ("sing" → "singer-songwriter"): on a
// pure count ordering a popular substring match can push the only completable
// candidate past the LIMIT, leaving Tab with nothing to accept.
func (r *Repo) Suggest(ctx context.Context, field, q string) ([]Suggestion, error) {
	norm := strings.ToLower(strings.TrimSpace(q))
	like := "%" + norm + "%"
	args := []any{like}
	var query string
	switch field {
	case "artist":
		query = `SELECT a.name, COUNT(s.id) c FROM artists a JOIN songs s ON s.artist_id = a.id
			WHERE a.name_key LIKE ? GROUP BY a.id ORDER BY c DESC, a.name LIMIT 10`
	case "album":
		query = `SELECT s.album, COUNT(*) c FROM songs s
			WHERE s.album IS NOT NULL AND trim(s.album) != '' AND lower(trim(s.album)) LIKE ?
			GROUP BY lower(trim(s.album)) ORDER BY c DESC, s.album LIMIT 10`
	case "genre":
		query = `SELECT g.name, COUNT(sg.song_id) c FROM genres g JOIN song_genres sg ON sg.genre_id = g.id
			WHERE lower(g.name) LIKE ? GROUP BY g.id
			ORDER BY (lower(g.name) LIKE ?) DESC, c DESC, g.name LIMIT 10`
		args = append(args, norm+"%")
	default:
		return nil, ErrUnknownSuggestField
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
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
