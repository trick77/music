package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// ErrReorderMismatch is returned when a reorder request's song set is not
// exactly the playlist's current membership (missing, extra, or duplicate ids).
var ErrReorderMismatch = errors.New("library: reorder set does not match playlist membership")

// PlaylistSummary is a playlist without its tracks, for list views.
type PlaylistSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CoverArtID  string `json:"coverArtId"`
	SongCount   int    `json:"songCount"`
	Published   bool   `json:"published"`
}

// playlistCountExpr is the SongCount subquery. For anonymous viewers it counts
// only published tracks, matching the track list they actually receive.
func playlistCountExpr(includeUnpublished bool) string {
	if includeUnpublished {
		return `(SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id)`
	}
	return `(SELECT COUNT(*) FROM playlist_songs ps JOIN songs s ON s.id = ps.song_id
	         WHERE ps.playlist_id = p.id AND s.is_published = 1)`
}

// PlaylistDetail is a playlist with its ordered tracks.
type PlaylistDetail struct {
	PlaylistSummary
	Songs []Song `json:"songs"`
}

// CreatePlaylist inserts a new, empty playlist and returns its id.
func (r *Repo) CreatePlaylist(ctx context.Context, name, description string) (string, error) {
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO playlists(id, name, description) VALUES(?,?,?)`,
		id, strings.TrimSpace(name), nullStr(description))
	if err != nil {
		return "", err
	}
	return id, nil
}

// UpdatePlaylist edits a playlist's name and description (not its cover/songs).
func (r *Repo) UpdatePlaylist(ctx context.Context, id, name, description string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE playlists SET name=?, description=? WHERE id=?`,
		strings.TrimSpace(name), nullStr(description), id)
	return err
}

// SetPlaylistPublished flips a playlist's publish state. Returns false if the id
// is unknown. Playlists are created unpublished; this is the only way to publish
// (or later unpublish) one, mirroring song publishing.
func (r *Repo) SetPlaylistPublished(ctx context.Context, id string, published bool) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE playlists SET is_published = ? WHERE id = ?`, boolToInt(published), id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// DeletePlaylist removes a playlist; playlist_songs rows cascade via FK.
func (r *Repo) DeletePlaylist(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM playlists WHERE id=?`, id)
	return err
}

// ListPlaylists returns playlists, newest first, each with its song count. For
// anonymous viewers (includeUnpublished=false) only published playlists are
// returned and counts are published-track only.
func (r *Repo) ListPlaylists(ctx context.Context, includeUnpublished bool) ([]PlaylistSummary, error) {
	where := ""
	if !includeUnpublished {
		where = " WHERE p.is_published = 1"
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id, `+playlistCountExpr(includeUnpublished)+`, p.is_published
		 FROM playlists p`+where+` ORDER BY p.created_at DESC, p.rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PlaylistSummary{}
	for rows.Next() {
		s, err := scanPlaylistSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// GetPlaylist returns a playlist with its ordered songs, or (nil,nil) if absent.
// includeUnpublished (an authenticated viewer) keeps unpublished tracks in the
// track list and returns unpublished playlists; anonymous callers only see
// published tracks and get (nil,nil) for an unpublished playlist (→ 404).
func (r *Repo) GetPlaylist(ctx context.Context, id string, includeUnpublished bool) (*PlaylistDetail, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id, `+playlistCountExpr(includeUnpublished)+`, p.is_published
		 FROM playlists p WHERE p.id = ?`, id)
	summary, err := scanPlaylistSummary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !includeUnpublished && !summary.Published {
		return nil, nil // unpublished playlists are invisible to anonymous callers
	}
	songs, err := r.playlistSongs(ctx, id, includeUnpublished)
	if err != nil {
		return nil, err
	}
	return &PlaylistDetail{PlaylistSummary: *summary, Songs: songs}, nil
}

// playlistSongs returns the playlist's songs ordered by position (then id for
// stable ties), with genres populated like List/Get.
func (r *Repo) playlistSongs(ctx context.Context, playlistID string, includeUnpublished bool) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx,
		songSelect+` JOIN playlist_songs ps ON ps.song_id = s.id
		 WHERE ps.playlist_id = ?`+publishedFilter(includeUnpublished, true)+` ORDER BY ps.position, s.id`, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	songs := []Song{}
	for rows.Next() {
		s, err := scanSong(rows)
		if err != nil {
			return nil, err
		}
		genres, err := r.genresFor(ctx, s.ID)
		if err != nil {
			return nil, err
		}
		s.Genres = genres
		songs = append(songs, *s)
	}
	return songs, rows.Err()
}

// AddSong appends a song to a playlist at the next position. Re-adding a song
// already in the playlist is a no-op (idempotent) so double-clicks are safe.
func (r *Repo) AddSong(ctx context.Context, playlistID, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO playlist_songs(playlist_id, song_id, position)
		 VALUES(?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?))
		 ON CONFLICT(playlist_id, song_id) DO NOTHING`,
		playlistID, songID, playlistID)
	return err
}

// RemoveSong removes a song from a playlist. Remaining positions keep their
// values (gaps are harmless — reads order by position, reorder rewrites them).
func (r *Repo) RemoveSong(ctx context.Context, playlistID, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM playlist_songs WHERE playlist_id=? AND song_id=?`, playlistID, songID)
	return err
}

// Reorder rewrites the playlist's track order to songIDs. It rejects any set
// that is not exactly the current membership (missing, extra, or duplicate) so
// a stale client cannot silently drop or invent rows.
func (r *Repo) Reorder(ctx context.Context, playlistID string, songIDs []string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	current := map[string]bool{}
	rows, err := tx.QueryContext(ctx,
		`SELECT song_id FROM playlist_songs WHERE playlist_id=?`, playlistID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			rows.Close()
			return err
		}
		current[sid] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(songIDs) != len(current) {
		return ErrReorderMismatch
	}
	seen := map[string]bool{}
	for _, sid := range songIDs {
		if seen[sid] || !current[sid] {
			return ErrReorderMismatch
		}
		seen[sid] = true
	}

	for pos, sid := range songIDs {
		if _, err := tx.ExecContext(ctx,
			`UPDATE playlist_songs SET position=? WHERE playlist_id=? AND song_id=?`,
			pos, playlistID, sid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetPlaylistCover assigns a cover image to a playlist.
func (r *Repo) SetPlaylistCover(ctx context.Context, playlistID, coverID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE playlists SET cover_art_id=? WHERE id=?`, coverID, playlistID)
	return err
}

func scanPlaylistSummary(row scanner) (*PlaylistSummary, error) {
	var p PlaylistSummary
	var desc, cover sql.NullString
	var published int64
	if err := row.Scan(&p.ID, &p.Name, &desc, &cover, &p.SongCount, &published); err != nil {
		return nil, err
	}
	p.Description = desc.String
	p.CoverArtID = cover.String
	p.Published = published != 0
	return &p, nil
}
