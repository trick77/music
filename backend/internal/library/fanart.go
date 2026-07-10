package library

import (
	"context"
	"database/sql"
	"errors"
)

// ErrFanartNotInGenre is returned when assigning a background/hero that does not
// belong to the target genre or is not a ready image.
var ErrFanartNotInGenre = errors.New("library: fanart does not belong to genre")

// Fanart is a fanart row. Server-only fields (ImagePath, Prompt, Model, ErrorMsg,
// Seed) are tagged json:"-" so no client — anonymous or authenticated — ever
// receives an image path, a generation prompt, a model name, or moderation text.
type Fanart struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	GenreID  string `json:"genreId"`
	Status   string `json:"status"`
	Caption  string `json:"caption"`
	IsActive bool   `json:"isActive"`
	IsHero   bool   `json:"isHero"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`

	ImagePath string `json:"-"`
	Prompt    string `json:"-"`
	Model     string `json:"-"`
	ErrorMsg  string `json:"-"`
	Seed      *int64 `json:"-"`
}

// FanartParams describes a fanart row to create.
type FanartParams struct {
	Kind, GenreID, ImagePath, Caption, Prompt, Model, Status string
	Width, Height                                            int
	Seed                                                     *int64
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// CreateFanart inserts a fanart row and returns its id.
func (r *Repo) CreateFanart(ctx context.Context, p FanartParams) (string, error) {
	if p.Status == "" {
		p.Status = "ready"
	}
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,genre_id,caption,prompt,model,seed,width,height,status)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, p.ImagePath, p.Kind, nullIfEmpty(p.GenreID), nullIfEmpty(p.Caption),
		nullIfEmpty(p.Prompt), nullIfEmpty(p.Model), p.Seed, p.Width, p.Height, p.Status)
	if err != nil {
		return "", err
	}
	return id, nil
}

// CreateGeneratingFanart inserts a placeholder row in the 'generating' state,
// recording the prompt/model/seed (server-only) for reference.
func (r *Repo) CreateGeneratingFanart(ctx context.Context, kind, genreID, prompt, model string, seed *int64) (string, error) {
	return r.CreateFanart(ctx, FanartParams{
		Kind: kind, GenreID: genreID, ImagePath: "", Status: "generating",
		Prompt: prompt, Model: model, Seed: seed,
	})
}

// MarkFanartReady records the downloaded image and clears any prior error.
func (r *Repo) MarkFanartReady(ctx context.Context, id, imagePath string, width, height int) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE fanart SET status='ready', image_path=?, width=?, height=?, error=NULL WHERE id=?`,
		imagePath, width, height, id)
	return err
}

// MarkFanartFailed records a terminal failure with a server-only reason.
func (r *Repo) MarkFanartFailed(ctx context.Context, id, reason string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE fanart SET status='failed', error=? WHERE id=?`, reason, id)
	return err
}

// FailOrphanedGenerating flips any rows still marked 'generating' to 'failed'.
// A generation goroutine cannot survive a process restart, so on boot every
// 'generating' row is orphaned; without this they would show a permanent
// spinner. Returns the number of rows reaped.
func (r *Repo) FailOrphanedGenerating(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE fanart SET status='failed', error='generation interrupted by a restart' WHERE status='generating'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

const fanartSelect = `SELECT id, kind, COALESCE(genre_id,''), status, COALESCE(caption,''),
	is_active, is_hero, width, height, image_path, COALESCE(prompt,''), COALESCE(model,''),
	COALESCE(error,''), seed FROM fanart`

func scanFanart(s interface{ Scan(...any) error }) (*Fanart, error) {
	var f Fanart
	var seed sql.NullInt64
	if err := s.Scan(&f.ID, &f.Kind, &f.GenreID, &f.Status, &f.Caption, &f.IsActive, &f.IsHero,
		&f.Width, &f.Height, &f.ImagePath, &f.Prompt, &f.Model, &f.ErrorMsg, &seed); err != nil {
		return nil, err
	}
	if seed.Valid {
		f.Seed = &seed.Int64
	}
	return &f, nil
}

// GetFanart returns a fanart row (including server-only fields), or nil if absent.
func (r *Repo) GetFanart(ctx context.Context, id string) (*Fanart, error) {
	f, err := scanFanart(r.db.QueryRowContext(ctx, fanartSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return f, err
}

// ListGenreFanart returns a genre's gallery, active background first.
func (r *Repo) ListGenreFanart(ctx context.Context, genreID string) ([]Fanart, error) {
	rows, err := r.db.QueryContext(ctx,
		fanartSelect+` WHERE genre_id=? ORDER BY is_active DESC, sort, created_at`, genreID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Fanart{}
	for rows.Next() {
		f, err := scanFanart(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// SetActiveBackground makes fanartID the genre's active background (exclusively).
// It rejects images that are not a ready 'genre' row of that genre.
func (r *Repo) SetActiveBackground(ctx context.Context, genreID, fanartID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	err = tx.QueryRowContext(ctx,
		`SELECT status FROM fanart WHERE id=? AND genre_id=? AND kind='genre'`, fanartID, genreID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrFanartNotInGenre
	}
	if err != nil {
		return err
	}
	if status != "ready" {
		return ErrFanartNotInGenre
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_active=0 WHERE genre_id=?`, genreID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_active=1 WHERE id=?`, fanartID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetGenreAccent stores a #rrggbb accent colour for a genre.
func (r *Repo) SetGenreAccent(ctx context.Context, genreID, hex string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE genres SET accent_color=? WHERE id=?`, hex, genreID)
	return err
}

// SetHero stars fanartID as the single global featured hero (exclusively).
func (r *Repo) SetHero(ctx context.Context, fanartID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT status FROM fanart WHERE id=?`, fanartID).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrFanartNotInGenre
		}
		return err
	}
	if status != "ready" {
		return ErrFanartNotInGenre
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_hero=0 WHERE is_hero=1`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_hero=1 WHERE id=?`, fanartID); err != nil {
		return err
	}
	return tx.Commit()
}

// ClearHero un-stars a fanart row as the featured hero.
func (r *Repo) ClearHero(ctx context.Context, fanartID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE fanart SET is_hero=0 WHERE id=?`, fanartID)
	return err
}

// UpdateGenreName renames a genre.
func (r *Repo) UpdateGenreName(ctx context.Context, genreID, name string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE genres SET name=? WHERE id=?`, name, genreID)
	return err
}
