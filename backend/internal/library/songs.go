// Package library persists songs, artists, and genres over the SQLite store.
package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Song is a stored track with its artist name and genres denormalized for reads.
type Song struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	ArtistID    string   `json:"artistId"`
	ArtistName  string   `json:"artistName"`
	Album       string   `json:"album"`
	Year        int      `json:"year"`
	TrackNo     int      `json:"trackNo"`
	DurationMS  int64    `json:"durationMs"`
	FilePath    string   `json:"-"`
	FileSize    int64    `json:"fileSize"`
	ContentHash string   `json:"-"`
	CoverArtID  string   `json:"coverArtId"`
	Genres      []string `json:"genres"`
	Lyrics      string   `json:"lyrics,omitempty"`
	CreatedAt   string   `json:"createdAt"`
	Published   bool     `json:"published"`
}

// CreateSongParams carries the data for a new song import.
type CreateSongParams struct {
	Title       string
	ArtistName  string
	Album       string
	Year        int
	TrackNo     int
	DurationMS  int64
	FileSize    int64
	FilePath    string
	ContentHash string
	Genres      []string
	Lyrics      string
}

type Repo struct{ db *sql.DB }

func NewRepo(db *sql.DB) *Repo { return &Repo{db: db} }

// Create upserts artist + genres and inserts the song and its genre links in a
// single transaction. The first genre is flagged is_primary.
func (r *Repo) Create(ctx context.Context, id string, p CreateSongParams) (*Song, error) {
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
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO songs(id, title, artist_id, album, year, track_no, duration_ms, file_path, file_size, content_hash, cover_art_id, lyrics)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo),
		p.DurationMS, p.FilePath, p.FileSize, p.ContentHash, nullStr(coverID), nullStr(p.Lyrics),
	); err != nil {
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
			id, genreID, primary,
		); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// FindByContentHash returns the song with the given hash, or (nil, nil).
func (r *Repo) FindByContentHash(ctx context.Context, hash string) (*Song, error) {
	if hash == "" {
		return nil, nil
	}
	var id string
	err := r.db.QueryRowContext(ctx, `SELECT id FROM songs WHERE content_hash = ?`, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// Get returns one song by id, or (nil, nil) if absent.
func (r *Repo) Get(ctx context.Context, id string) (*Song, error) {
	row := r.db.QueryRowContext(ctx, songSelect+` WHERE s.id = ?`, id)
	song, err := scanSong(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	genres, err := r.genresFor(ctx, id)
	if err != nil {
		return nil, err
	}
	song.Genres = genres
	return song, nil
}

// DeleteSong removes a song and returns its stored audio file path so the caller
// can delete the file. existed is false when no such song was present. Child rows
// (plays, playlist_songs, song_genres) cascade via FK. Cover art is not touched.
func (r *Repo) DeleteSong(ctx context.Context, id string) (filePath string, existed bool, err error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT file_path FROM songs WHERE id=?`, id).Scan(&filePath)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM songs WHERE id=?`, id); err != nil {
		return "", false, err
	}
	if err = tx.Commit(); err != nil {
		return "", false, err
	}
	return filePath, true, nil
}

// List returns all songs, newest first. includeUnpublished includes unpublished
// songs (an authenticated viewer); anonymous callers pass false.
func (r *Repo) List(ctx context.Context, includeUnpublished bool) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+publishedFilter(includeUnpublished, false)+` ORDER BY s.created_at DESC, s.rowid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var songs []Song
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

const songSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.lyrics, s.created_at, s.is_published
	FROM songs s JOIN artists a ON a.id = s.artist_id`

// publishedFilter appends a clause restricting to published songs. hasWhere
// selects AND vs WHERE; includeUnpublished (an authenticated viewer) yields "".
func publishedFilter(includeUnpublished, hasWhere bool) string {
	if includeUnpublished {
		return ""
	}
	if hasWhere {
		return " AND s.is_published = 1"
	}
	return " WHERE s.is_published = 1"
}

type scanner interface {
	Scan(dest ...any) error
}

func scanSong(row scanner) (*Song, error) {
	var s Song
	var album, cover, lyrics sql.NullString
	var year, track sql.NullInt64
	var published int64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &lyrics, &s.CreatedAt, &published); err != nil {
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

func (r *Repo) genresFor(ctx context.Context, songID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT g.name FROM song_genres sg JOIN genres g ON g.id = sg.genre_id
		 WHERE sg.song_id = ? ORDER BY sg.is_primary DESC, g.name`, songID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	genres := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		genres = append(genres, name)
	}
	return genres, rows.Err()
}

func upsertArtist(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Unknown artist"
	}
	key := strings.ToLower(name)
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM artists WHERE name_key = ?`, key).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO artists(id, name, name_key) VALUES(?,?,?)`, id, name, key)
	return id, err
}

func upsertGenre(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	// Store genre names canonically lowercase; the UI title-cases them for display.
	name = strings.ToLower(strings.TrimSpace(name))
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM genres WHERE name = ? COLLATE NOCASE`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO genres(id, name) VALUES(?,?)`, id, name)
	return id, err
}

func dedupeGenres(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range in {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		k := strings.ToLower(g)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, g)
	}
	return out
}

func nullStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
