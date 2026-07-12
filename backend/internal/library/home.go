package library

import (
	"context"
	"database/sql"
	"errors"
)

// HomeHero is the immersive Home hero, derived from the starred is_hero fanart.
// It references imagery only by id — never an image path, prompt, model, or any
// generation detail (the no-AI-in-UI invariant).
type HomeHero struct {
	FanartID    string `json:"fanartId"`
	Kind        string `json:"kind"`
	GenreID     string `json:"genreId"`
	Title       string `json:"title"`
	Subtitle    string `json:"subtitle"`
	AccentColor string `json:"accentColor"`
}

// GenreChapter is one immersive "chapter" on Home: a genre, its active-background
// fanart id, its accent, and a sample of its songs for the chapter rail.
type GenreChapter struct {
	GenreSummary
	BackgroundFanartID string `json:"backgroundFanartId"`
	Songs              []Song `json:"songs"`
}

// HomeFeed is the whole Home payload. Every slice is non-nil so it JSON-encodes
// as [] (never null), and every section degrades gracefully when empty.
type HomeFeed struct {
	Hero          *HomeHero         `json:"hero"`
	TopTen        []TopTenEntry     `json:"topTen"`
	RecentlyAdded []Song            `json:"recentlyAdded"`
	Genres        []GenreChapter    `json:"genres"`
	Playlists     []PlaylistSummary `json:"playlists"`
}

// HeroFanart returns the single starred, ready hero fanart, or (nil, nil).
func (r *Repo) HeroFanart(ctx context.Context) (*Fanart, error) {
	f, err := scanFanart(r.db.QueryRowContext(ctx, fanartSelect+` WHERE is_hero=1 AND status='ready' LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return f, err
}

// RecentSongs returns the newest songs, limited. includeUnpublished includes
// unpublished songs (an authenticated viewer).
//
// The tie-break is s.rowid (insertion order), NOT s.id: id is a random hex
// (NewID), so ordering by it is arbitrary — songs added within the same second
// (created_at is 1-second resolution) would sort unpredictably. rowid strictly
// increases with insertion, making "newest added first" deterministic.
func (r *Repo) RecentSongs(ctx context.Context, limit int, includeUnpublished bool) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+publishedFilter(includeUnpublished, false)+` ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return r.hydrateSongs(ctx, rows)
}

// genreSongs returns a genre's songs, newest first, limited.
func (r *Repo) genreSongs(ctx context.Context, genreID string, limit int, includeUnpublished bool) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx,
		songSelect+` WHERE s.id IN (SELECT song_id FROM song_genres WHERE genre_id = ?)`+publishedFilter(includeUnpublished, true)+`
		ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`, genreID, limit)
	if err != nil {
		return nil, err
	}
	return r.hydrateSongs(ctx, rows)
}

// hydrateSongs scans a songSelect rowset and fills each song's genres.
func (r *Repo) hydrateSongs(ctx context.Context, rows *sql.Rows) ([]Song, error) {
	defer rows.Close()
	out := []Song{}
	for rows.Next() {
		s, err := scanSong(rows)
		if err != nil {
			return nil, err
		}
		g, err := r.genresFor(ctx, s.ID)
		if err != nil {
			return nil, err
		}
		s.Genres = g
		out = append(out, *s)
	}
	return out, rows.Err()
}

// activeBackgroundID returns the id of a genre's active, ready background fanart, or "".
func (r *Repo) activeBackgroundID(ctx context.Context, genreID string) (string, error) {
	var id string
	err := r.db.QueryRowContext(ctx,
		`SELECT id FROM fanart WHERE genre_id=? AND is_active=1 AND status='ready' LIMIT 1`, genreID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// HomeFeed assembles the immersive Home payload. recentLimit caps Recently-added;
// chapterSongLimit caps each genre chapter's song rail. includeUnpublished
// (an authenticated viewer) surfaces unpublished songs across every section.
func (r *Repo) HomeFeed(ctx context.Context, recentLimit, chapterSongLimit int, includeUnpublished bool) (*HomeFeed, error) {
	feed := &HomeFeed{
		TopTen:        []TopTenEntry{},
		RecentlyAdded: []Song{},
		Genres:        []GenreChapter{},
		Playlists:     []PlaylistSummary{},
	}

	hero, err := r.HeroFanart(ctx)
	if err != nil {
		return nil, err
	}
	if hero != nil {
		hh := &HomeHero{FanartID: hero.ID, Kind: hero.Kind, GenreID: hero.GenreID, Title: hero.Caption}
		if hero.GenreID != "" {
			// Anonymous viewers must not learn a hidden genre's name/accent via the
			// hero, and must not be linked to a genre page that would 404 — only
			// resolve the genre when it has at least one published song for them.
			query := `SELECT name, COALESCE(accent_color,'') FROM genres WHERE id=?`
			if !includeUnpublished {
				query = `SELECT g.name, COALESCE(g.accent_color,'') FROM genres g
					WHERE g.id=? AND EXISTS(SELECT 1 FROM song_genres sg JOIN songs s ON s.id = sg.song_id
					                        WHERE sg.genre_id = g.id AND s.is_published = 1)`
			}
			var name, accent string
			switch err := r.db.QueryRowContext(ctx, query, hero.GenreID).Scan(&name, &accent); {
			case errors.Is(err, sql.ErrNoRows):
				if !includeUnpublished {
					hh.GenreID = "" // hidden from this viewer — don't link to a 404
				}
			case err != nil:
				return nil, err
			default:
				if hh.Title == "" {
					hh.Title = name
				}
				hh.AccentColor = accent
			}
		}
		if hh.Title == "" {
			hh.Title = "Featured"
		}
		feed.Hero = hh
	}

	if feed.TopTen, err = r.TopTen(ctx, includeUnpublished); err != nil {
		return nil, err
	}
	if feed.RecentlyAdded, err = r.RecentSongs(ctx, recentLimit, includeUnpublished); err != nil {
		return nil, err
	}

	genres, err := r.ListGenres(ctx, includeUnpublished) // anonymous: also omits genres with no published songs
	if err != nil {
		return nil, err
	}
	// Only chapter the genres represented in the Top Ten or Recently Added — an
	// unbounded chapter per library genre made the feed scroll forever as the
	// library grew. On a fresh library both sections are empty; fall back to
	// showing every genre so the section isn't just blank.
	//
	// Each song contributes only its primary (first) genre — genresFor orders
	// is_primary DESC, so Genres[0] is the main genre. A multi-genre song surfaces
	// under its main genre rather than fanning out a chapter for every secondary tag.
	featuredGenreNames := map[string]bool{}
	for _, s := range feed.TopTen {
		if len(s.Genres) > 0 {
			featuredGenreNames[s.Genres[0]] = true
		}
	}
	for _, s := range feed.RecentlyAdded {
		if len(s.Genres) > 0 {
			featuredGenreNames[s.Genres[0]] = true
		}
	}
	for _, g := range genres {
		if len(featuredGenreNames) > 0 && !featuredGenreNames[g.Name] {
			continue
		}
		bg, err := r.activeBackgroundID(ctx, g.ID)
		if err != nil {
			return nil, err
		}
		songs, err := r.genreSongs(ctx, g.ID, chapterSongLimit, includeUnpublished)
		if err != nil {
			return nil, err
		}
		feed.Genres = append(feed.Genres, GenreChapter{GenreSummary: g, BackgroundFanartID: bg, Songs: songs})
	}

	if feed.Playlists, err = r.ListPlaylists(ctx, includeUnpublished); err != nil {
		return nil, err
	}
	return feed, nil
}
