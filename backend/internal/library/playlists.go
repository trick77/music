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

// DeletePlaylist removes a playlist; playlist_songs rows cascade via FK.
func (r *Repo) DeletePlaylist(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM playlists WHERE id=?`, id)
	return err
}

// ListPlaylists returns all playlists, newest first, each with its song count.
func (r *Repo) ListPlaylists(ctx context.Context) ([]PlaylistSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id,
		        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id)
		 FROM playlists p ORDER BY p.created_at DESC, p.id DESC`)
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
// track list; anonymous callers only see published tracks.
func (r *Repo) GetPlaylist(ctx context.Context, id string, includeUnpublished bool) (*PlaylistDetail, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id,
		        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id)
		 FROM playlists p WHERE p.id = ?`, id)
	summary, err := scanPlaylistSummary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
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
	if err := row.Scan(&p.ID, &p.Name, &desc, &cover, &p.SongCount); err != nil {
		return nil, err
	}
	p.Description = desc.String
	p.CoverArtID = cover.String
	return &p, nil
}
