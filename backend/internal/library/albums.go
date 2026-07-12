package library

import (
	"context"
	"database/sql"
	"errors"
)

// AlbumPromptContext carries what the album-cover prompt author needs about an
// album: the artist's display name, the distinct genre names across the
// album's songs, and lyric excerpts from songs that have them. Exists reports
// whether any song matched (so a bad artist/album pair is a 404, not an empty
// prompt).
type AlbumPromptContext struct {
	ArtistName string
	Genres     []string
	Lyrics     []SongLyric
	Exists     bool
}

// SongLyric is a lyric excerpt from one song, used to ground an album-cover
// prompt in the album's actual imagery and themes.
type SongLyric struct {
	Title  string
	Lyrics string
}

// maxAlbumCoverLyricSongs caps how many lyric-bearing songs feed an album-cover
// prompt, and maxAlbumCoverLyricChars caps each excerpt's length — enough for
// thematic grounding without bloating the completion.
const (
	maxAlbumCoverLyricSongs = 5
	maxAlbumCoverLyricChars = 1200
)

// AlbumContext resolves the artist name and distinct genres for an artist+album,
// grouped case-insensitively by lower(trim(album)) to match album_covers. Authed-only
// surface, so it considers all songs regardless of publish state.
func (r *Repo) AlbumContext(ctx context.Context, artistID, album string) (AlbumPromptContext, error) {
	key := albumKey(album)
	if artistID == "" || key == "" {
		return AlbumPromptContext{}, nil
	}
	var out AlbumPromptContext
	err := r.db.QueryRowContext(ctx,
		`SELECT a.name FROM artists a
		 WHERE a.id = ? AND EXISTS(
		   SELECT 1 FROM songs s WHERE s.artist_id = a.id AND lower(trim(s.album)) = ?)`,
		artistID, key).Scan(&out.ArtistName)
	if errors.Is(err, sql.ErrNoRows) {
		return AlbumPromptContext{}, nil
	}
	if err != nil {
		return AlbumPromptContext{}, err
	}
	out.Exists = true

	rows, err := r.db.QueryContext(ctx,
		`SELECT DISTINCT g.name FROM genres g
		 JOIN song_genres sg ON sg.genre_id = g.id
		 JOIN songs s ON s.id = sg.song_id
		 WHERE s.artist_id = ? AND lower(trim(s.album)) = ?
		 ORDER BY g.name`,
		artistID, key)
	if err != nil {
		return AlbumPromptContext{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return AlbumPromptContext{}, err
		}
		out.Genres = append(out.Genres, name)
	}
	if err := rows.Err(); err != nil {
		return AlbumPromptContext{}, err
	}

	lyricRows, err := r.db.QueryContext(ctx,
		`SELECT s.title, s.lyrics FROM songs s
		 WHERE s.artist_id = ? AND lower(trim(s.album)) = ? AND s.lyrics != ''
		 ORDER BY s.track_no LIMIT ?`,
		artistID, key, maxAlbumCoverLyricSongs)
	if err != nil {
		return AlbumPromptContext{}, err
	}
	defer lyricRows.Close()
	for lyricRows.Next() {
		var sl SongLyric
		if err := lyricRows.Scan(&sl.Title, &sl.Lyrics); err != nil {
			return AlbumPromptContext{}, err
		}
		if len(sl.Lyrics) > maxAlbumCoverLyricChars {
			sl.Lyrics = sl.Lyrics[:maxAlbumCoverLyricChars]
		}
		out.Lyrics = append(out.Lyrics, sl)
	}
	return out, lyricRows.Err()
}
