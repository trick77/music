package library

import (
	"context"
	"database/sql"
	"errors"
)

// ArtistSummary is an artist with its song count for browse lists.
type ArtistSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SongCount int    `json:"songCount"`
}

// GenreSummary is a genre with its song count and auto-sampled accent colour.
// HasBackground reports whether the genre has an active generated/uploaded
// background image, so the UI can flag genres that still need artwork.
type GenreSummary struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	SongCount     int    `json:"songCount"`
	AccentColor   string `json:"accentColor"`
	HasBackground bool   `json:"hasBackground"`
}

// ListArtists returns artists with a song count. For anonymous viewers
// (includeUnpublished=false) the count is published-only and artists with no
// published songs are omitted entirely — an unpublished-only artist does not
// exist publicly until one of its songs is published.
func (r *Repo) ListArtists(ctx context.Context, includeUnpublished bool) ([]ArtistSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT a.id, a.name, COUNT(s.id) c FROM artists a JOIN songs s ON s.artist_id = a.id`+
			publishedFilter(includeUnpublished, false)+
			` GROUP BY a.id ORDER BY a.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ArtistSummary{}
	for rows.Next() {
		var a ArtistSummary
		if err := rows.Scan(&a.ID, &a.Name, &a.SongCount); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *Repo) GetArtist(ctx context.Context, id string, includeUnpublished bool) (*ArtistSummary, []Song, error) {
	// Anonymous viewers count published songs only; an artist with none is hidden
	// (nil → 404 in the handler), matching ListArtists/search.
	join := "LEFT JOIN songs s ON s.artist_id = a.id"
	if !includeUnpublished {
		join = "LEFT JOIN songs s ON s.artist_id = a.id AND s.is_published = 1"
	}
	var a ArtistSummary
	err := r.db.QueryRowContext(ctx,
		`SELECT a.id, a.name, COUNT(s.id) c FROM artists a `+join+`
		 WHERE a.id = ? GROUP BY a.id`, id).Scan(&a.ID, &a.Name, &a.SongCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if !includeUnpublished && a.SongCount == 0 {
		return nil, nil, nil
	}
	songs, err := r.songsWhere(ctx, includeUnpublished, `s.artist_id = ?`, id)
	return &a, songs, err
}

// ListGenres returns genres with a song count. For anonymous viewers the count
// is published-only and genres with no published songs are omitted, mirroring
// ListArtists.
func (r *Repo) ListGenres(ctx context.Context, includeUnpublished bool) ([]GenreSummary, error) {
	songJoin := ""
	if !includeUnpublished {
		songJoin = " JOIN songs s ON s.id = sg.song_id AND s.is_published = 1"
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT g.id, g.name, COALESCE(g.accent_color,''), COUNT(sg.song_id) c,
		        EXISTS(SELECT 1 FROM fanart f WHERE f.genre_id = g.id AND f.kind='genre' AND f.is_active=1) hasbg
		 FROM genres g JOIN song_genres sg ON sg.genre_id = g.id`+songJoin+`
		 GROUP BY g.id ORDER BY g.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GenreSummary{}
	for rows.Next() {
		var g GenreSummary
		var hasBg int
		if err := rows.Scan(&g.ID, &g.Name, &g.AccentColor, &g.SongCount, &hasBg); err != nil {
			return nil, err
		}
		g.HasBackground = hasBg != 0
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *Repo) GetGenre(ctx context.Context, id string, includeUnpublished bool) (*GenreSummary, []Song, error) {
	// Anonymous viewers count published songs only; a genre with none is hidden
	// (nil → 404 in the handler).
	songJoin := "LEFT JOIN song_genres sg ON sg.genre_id = g.id"
	countExpr := "COUNT(sg.song_id)"
	if !includeUnpublished {
		songJoin = "LEFT JOIN song_genres sg ON sg.genre_id = g.id LEFT JOIN songs s ON s.id = sg.song_id AND s.is_published = 1"
		countExpr = "COUNT(s.id)"
	}
	var g GenreSummary
	var hasBg int
	err := r.db.QueryRowContext(ctx,
		`SELECT g.id, g.name, COALESCE(g.accent_color,''), `+countExpr+` c,
		        EXISTS(SELECT 1 FROM fanart f WHERE f.genre_id = g.id AND f.kind='genre' AND f.is_active=1) hasbg
		 FROM genres g `+songJoin+`
		 WHERE g.id = ? GROUP BY g.id`, id).Scan(&g.ID, &g.Name, &g.AccentColor, &g.SongCount, &hasBg)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if !includeUnpublished && g.SongCount == 0 {
		return nil, nil, nil
	}
	g.HasBackground = hasBg != 0
	songs, err := r.songsWhere(ctx, includeUnpublished,
		`s.id IN (SELECT song_id FROM song_genres WHERE genre_id = ?)`, id)
	return &g, songs, err
}

// songsWhere runs songSelect with an extra WHERE clause and hydrates genres.
// Anonymous viewers (includeUnpublished=false) additionally exclude unpublished songs.
func (r *Repo) songsWhere(ctx context.Context, includeUnpublished bool, where string, args ...any) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+" WHERE "+where+publishedFilter(includeUnpublished, true)+" ORDER BY s.created_at DESC, s.rowid DESC", args...)
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
