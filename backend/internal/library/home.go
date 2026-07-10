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

// RecentSongs returns the newest songs, limited.
func (r *Repo) RecentSongs(ctx context.Context, limit int) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+` ORDER BY s.created_at DESC, s.id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return r.hydrateSongs(ctx, rows)
}

// genreSongs returns a genre's songs, newest first, limited.
func (r *Repo) genreSongs(ctx context.Context, genreID string, limit int) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx,
		songSelect+` WHERE s.id IN (SELECT song_id FROM song_genres WHERE genre_id = ?)
		ORDER BY s.created_at DESC, s.id DESC LIMIT ?`, genreID, limit)
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
// chapterSongLimit caps each genre chapter's song rail.
func (r *Repo) HomeFeed(ctx context.Context, recentLimit, chapterSongLimit int) (*HomeFeed, error) {
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
			var name, accent string
			if err := r.db.QueryRowContext(ctx,
				`SELECT name, COALESCE(accent_color,'') FROM genres WHERE id=?`, hero.GenreID).Scan(&name, &accent); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if hh.Title == "" {
				hh.Title = name
			}
			hh.AccentColor = accent
		}
		if hh.Title == "" {
			hh.Title = "Featured"
		}
		feed.Hero = hh
	}

	if feed.TopTen, err = r.TopTen(ctx); err != nil {
		return nil, err
	}
	if feed.RecentlyAdded, err = r.RecentSongs(ctx, recentLimit); err != nil {
		return nil, err
	}

	genres, err := r.ListGenres(ctx) // JOINs song_genres, so zero-song genres are already omitted
	if err != nil {
		return nil, err
	}
	for _, g := range genres {
		bg, err := r.activeBackgroundID(ctx, g.ID)
		if err != nil {
			return nil, err
		}
		songs, err := r.genreSongs(ctx, g.ID, chapterSongLimit)
		if err != nil {
			return nil, err
		}
		feed.Genres = append(feed.Genres, GenreChapter{GenreSummary: g, BackgroundFanartID: bg, Songs: songs})
	}

	if feed.Playlists, err = r.ListPlaylists(ctx); err != nil {
		return nil, err
	}
	return feed, nil
}
