package library

import (
	"context"
	"strings"
)

// SearchHit identifies the single best result across all groups.
type SearchHit struct {
	Type string `json:"type"` // song | artist | genre | playlist
	ID   string `json:"id"`
}

// SearchResults are grouped, deduped search results.
type SearchResults struct {
	Top       *SearchHit        `json:"top"`
	Songs     []Song            `json:"songs"`
	Artists   []ArtistSummary   `json:"artists"`
	Genres    []GenreSummary    `json:"genres"`
	Playlists []PlaylistSummary `json:"playlists"`
}

// escapeLike escapes the LIKE metacharacters so user input is matched literally
// (paired with ESCAPE '\' in the queries).
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// Search runs a case-insensitive substring match across songs (title), artists,
// genres, and playlists (name), each group capped at limit.
func (r *Repo) Search(ctx context.Context, q string, limit int, includeUnpublished bool) (*SearchResults, error) {
	res := &SearchResults{
		Songs:     []Song{},
		Artists:   []ArtistSummary{},
		Genres:    []GenreSummary{},
		Playlists: []PlaylistSummary{},
	}
	q = strings.TrimSpace(q)
	if q == "" {
		return res, nil
	}
	like := "%" + escapeLike(q) + "%"

	songRows, err := r.db.QueryContext(ctx,
		songSelect+` WHERE s.title LIKE ? ESCAPE '\'`+publishedFilter(includeUnpublished, true)+` ORDER BY lower(s.title), s.id LIMIT ?`, like, limit)
	if err != nil {
		return nil, err
	}
	if res.Songs, err = r.hydrateSongs(ctx, songRows); err != nil {
		return nil, err
	}

	if res.Artists, err = r.searchArtists(ctx, like, limit, includeUnpublished); err != nil {
		return nil, err
	}
	if res.Genres, err = r.searchGenres(ctx, like, limit, includeUnpublished); err != nil {
		return nil, err
	}
	if res.Playlists, err = r.searchPlaylists(ctx, like, limit, includeUnpublished); err != nil {
		return nil, err
	}

	res.Top = pickTop(q, res)
	return res, nil
}

// searchArtists matches artists by name. Anonymous viewers see published-only
// counts and no artist whose songs are all unpublished.
func (r *Repo) searchArtists(ctx context.Context, like string, limit int, includeUnpublished bool) ([]ArtistSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT a.id, a.name, COUNT(s.id) FROM artists a JOIN songs s ON s.artist_id = a.id
		 WHERE a.name LIKE ? ESCAPE '\'`+publishedFilter(includeUnpublished, true)+` GROUP BY a.id ORDER BY a.name LIMIT ?`, like, limit)
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

// searchGenres matches genres by name. Anonymous viewers see published-only
// counts and no genre whose songs are all unpublished.
func (r *Repo) searchGenres(ctx context.Context, like string, limit int, includeUnpublished bool) ([]GenreSummary, error) {
	songJoin := ""
	if !includeUnpublished {
		songJoin = " JOIN songs s ON s.id = sg.song_id AND s.is_published = 1"
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT g.id, g.name, COALESCE(g.accent_color,''), COUNT(sg.song_id) FROM genres g
		 JOIN song_genres sg ON sg.genre_id = g.id`+songJoin+`
		 WHERE g.name LIKE ? ESCAPE '\' GROUP BY g.id ORDER BY g.name LIMIT ?`, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GenreSummary{}
	for rows.Next() {
		var g GenreSummary
		if err := rows.Scan(&g.ID, &g.Name, &g.AccentColor, &g.SongCount); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// searchPlaylists matches playlists by name. Anonymous viewers only see
// published playlists, with published-track counts.
func (r *Repo) searchPlaylists(ctx context.Context, like string, limit int, includeUnpublished bool) ([]PlaylistSummary, error) {
	pubFilter := ""
	if !includeUnpublished {
		pubFilter = " AND p.is_published = 1"
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id, `+playlistCountExpr(includeUnpublished)+`, p.is_published
		 FROM playlists p WHERE p.name LIKE ? ESCAPE '\'`+pubFilter+` ORDER BY p.name LIMIT ?`, like, limit)
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

// pickTop chooses the single best hit: an exact (case-insensitive) name/title
// match wins; otherwise the first result by group precedence song > artist >
// genre > playlist.
func pickTop(q string, res *SearchResults) *SearchHit {
	ql := strings.ToLower(q)
	for _, s := range res.Songs {
		if strings.ToLower(s.Title) == ql {
			return &SearchHit{Type: "song", ID: s.ID}
		}
	}
	for _, a := range res.Artists {
		if strings.ToLower(a.Name) == ql {
			return &SearchHit{Type: "artist", ID: a.ID}
		}
	}
	for _, g := range res.Genres {
		if strings.ToLower(g.Name) == ql {
			return &SearchHit{Type: "genre", ID: g.ID}
		}
	}
	for _, p := range res.Playlists {
		if strings.ToLower(p.Name) == ql {
			return &SearchHit{Type: "playlist", ID: p.ID}
		}
	}
	switch {
	case len(res.Songs) > 0:
		return &SearchHit{Type: "song", ID: res.Songs[0].ID}
	case len(res.Artists) > 0:
		return &SearchHit{Type: "artist", ID: res.Artists[0].ID}
	case len(res.Genres) > 0:
		return &SearchHit{Type: "genre", ID: res.Genres[0].ID}
	case len(res.Playlists) > 0:
		return &SearchHit{Type: "playlist", ID: res.Playlists[0].ID}
	}
	return nil
}
