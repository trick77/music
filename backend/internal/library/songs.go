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
	ID         string `json:"id"`
	Title      string `json:"title"`
	ArtistID   string `json:"artistId"`
	ArtistName string `json:"artistName"`
	Album      string `json:"album"`
	Year       int    `json:"year"`
	TrackNo    int    `json:"trackNo"`
	// TrackTotal is the number of songs in this song's artist+album group ("Y" in
	// "N of Y"). 0 for singles (empty album), which are never auto-numbered.
	TrackTotal int   `json:"trackTotal"`
	DurationMS int64 `json:"durationMs"`
	// Audio properties of the stored file, for the tag editor's Info tab. 0 means
	// "unknown" — not yet backfilled, or undecodable; the UI renders "—".
	SampleRate  int      `json:"sampleRate"`
	Channels    int      `json:"channels"`
	BitrateKbps int      `json:"bitrateKbps"`
	FilePath    string   `json:"-"`
	FileSize    int64    `json:"fileSize"`
	ContentHash string   `json:"-"`
	CoverArtID  string   `json:"coverArtId"`
	Genres      []string `json:"genres"`
	Lyrics      string   `json:"lyrics,omitempty"`
	CreatedAt   string   `json:"createdAt"`
	Published   bool     `json:"published"`
	// AlignmentStatus is the karaoke word-timing state ("" = never requested,
	// generating|ready|failed). Rides every song payload via a LEFT JOIN so list
	// rows can show a "syncing" indicator (Phase 3).
	AlignmentStatus string `json:"alignmentStatus"`
}

// CreateSongParams carries the data for a new song import.
type CreateSongParams struct {
	Title       string
	ArtistName  string
	Album       string
	Year        int
	TrackNo     int
	DurationMS  int64
	SampleRate  int
	Channels    int
	BitrateKbps int
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
		`INSERT INTO songs(id, title, artist_id, album, year, track_no, duration_ms, file_path, file_size, content_hash, cover_art_id, lyrics, sample_rate, channels, bitrate_kbps)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, p.Title, artistID, normalizeAlbum(p.Album), nullInt(p.Year), nullInt(p.TrackNo),
		p.DurationMS, p.FilePath, p.FileSize, p.ContentHash, nullStr(coverID), nullStr(p.Lyrics),
		// NULL rather than 0 for an undecodable file, so it's indistinguishable from
		// a not-yet-backfilled row and the backfill can retry it.
		nullInt(p.SampleRate), nullInt(p.Channels), nullInt(p.BitrateKbps),
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
	if err := renumberAlbumTx(ctx, tx, artistID, albumKey(p.Album)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// renumberAlbumTx re-sequences track_no (1..N by add order) and sets track_total=N
// for every song in one artist+album group, so a group stays consistently numbered
// "N of Y" whenever a member is added, removed, or moved. Add order is rowid, which
// is monotonic and unique, so the newest upload always sorts last. It is a no-op for
// an empty album key: singles are never auto-numbered. Runs inside the caller's write
// transaction so numbering is atomic with the row change that triggered it. Counts
// unpublished songs deliberately — a just-uploaded (still unpublished) song must bump
// the group total immediately.
func renumberAlbumTx(ctx context.Context, tx *sql.Tx, artistID, key string) error {
	if key == "" {
		return nil
	}
	// rn is a running sequence (ORDER BY rowid); cnt is the whole-group total, so it
	// uses an unordered window — an ORDER BY window would count only up to the current
	// row (a running total), not the group size.
	_, err := tx.ExecContext(ctx, `
		UPDATE songs SET track_no = sub.rn, track_total = sub.cnt
		FROM (
			SELECT id,
				ROW_NUMBER() OVER (ORDER BY rowid) AS rn,
				COUNT(*)     OVER ()               AS cnt
			FROM songs
			WHERE artist_id = ? AND lower(trim(album)) = ?
		) sub
		WHERE songs.id = sub.id`, artistID, key)
	return err
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
	// Remember the group so the survivors can be renumbered once this song is gone.
	var artistID string
	var album sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT file_path, artist_id, album FROM songs WHERE id=?`, id).Scan(&filePath, &artistID, &album)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM songs WHERE id=?`, id); err != nil {
		return "", false, err
	}
	if err = renumberAlbumTx(ctx, tx, artistID, albumKey(album.String)); err != nil {
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

// songColumns is the ONE column list every song read shares, and its order is the
// contract scanSongInto scans in. It was duplicated between here and topTenSelect;
// they must agree, so they now derive from this. Anything appending extra columns
// (topTenSelect's play count) must append AFTER these.
const songColumns = `s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no, s.track_total,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.lyrics, s.created_at, s.is_published,
	s.sample_rate, s.channels, s.bitrate_kbps,
	COALESCE(al.status, '') AS alignment_status`

const songFrom = ` FROM songs s JOIN artists a ON a.id = s.artist_id
	LEFT JOIN song_alignment al ON al.song_id = s.id`

const songSelect = `SELECT ` + songColumns + songFrom

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

func scanSong(row scanner) (*Song, error) { return scanSongInto(row, nil) }

// scanSongInto scans songColumns in order. When count is non-nil it scans one
// trailing column into it — the shape topTenSelect produces. Single scanner so the
// column list and the scan order can't drift apart.
func scanSongInto(row scanner, count *int) (*Song, error) {
	var s Song
	var album, cover, lyrics sql.NullString
	var year, track, trackTotal sql.NullInt64
	// Audio info is NULL for rows the backfill hasn't reached and for files that
	// can't be decoded; both surface as 0 and render "—".
	var sampleRate, channels, bitrate sql.NullInt64
	var published int64
	dest := []any{&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track, &trackTotal,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &lyrics, &s.CreatedAt, &published,
		&sampleRate, &channels, &bitrate,
		&s.AlignmentStatus}
	if count != nil {
		dest = append(dest, count)
	}
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.TrackTotal = int(trackTotal.Int64)
	s.CoverArtID = cover.String
	s.Lyrics = lyrics.String
	s.SampleRate = int(sampleRate.Int64)
	s.Channels = int(channels.Int64)
	s.BitrateKbps = int(bitrate.Int64)
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

// normalizeAlbum trims surrounding whitespace before storing an album so the
// persisted songs.album matches albumKey and every album grouping/propagation
// query. Real ID3 tags routinely carry trailing spaces or null padding; storing
// them raw silently splits an album so a shared cover never reaches siblings.
// Empty (after trim) becomes SQL NULL, matching nullStr.
func normalizeAlbum(s string) any {
	t := strings.TrimSpace(s)
	if t == "" {
		return nil
	}
	return t
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
