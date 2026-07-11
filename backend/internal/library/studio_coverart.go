package library

import (
	"context"
	"database/sql"
	"errors"
)

// StudioCoverArt is a persisted Studio cover-art image. Image path, prompt,
// model, seed, and error are server-only and never serialized to clients.
type StudioCoverArt struct {
	ID     string
	Status string
	Width  int
	Height int

	ImagePath string
	Prompt    string
	Model     string
	ErrorMsg  string
	Seed      *int64
}

const studioCoverArtSelect = `SELECT id, status, width, height, image_path,
	COALESCE(prompt,''), COALESCE(model,''), COALESCE(error,''), seed FROM studio_coverart`

// CreateStudioCoverArt inserts a ready cover-art row, recording the server-only
// prompt/model/seed. Studio cover art is generated synchronously, so rows are
// written only on success and always in the 'ready' state.
func (r *Repo) CreateStudioCoverArt(ctx context.Context, id, imagePath, prompt, model string, seed *int64, width, height int) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO studio_coverart(id,image_path,prompt,model,seed,width,height,status)
		 VALUES(?,?,?,?,?,?,?, 'ready')`,
		id, imagePath, nullIfEmpty(prompt), nullIfEmpty(model), seed, width, height)
	return err
}

// GetStudioCoverArt returns the row, or (nil, nil) when absent.
func (r *Repo) GetStudioCoverArt(ctx context.Context, id string) (*StudioCoverArt, error) {
	c, err := scanStudioCoverArt(r.db.QueryRowContext(ctx, studioCoverArtSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return c, err
}

func scanStudioCoverArt(s interface{ Scan(...any) error }) (*StudioCoverArt, error) {
	var c StudioCoverArt
	var seed sql.NullInt64
	if err := s.Scan(&c.ID, &c.Status, &c.Width, &c.Height, &c.ImagePath,
		&c.Prompt, &c.Model, &c.ErrorMsg, &seed); err != nil {
		return nil, err
	}
	if seed.Valid {
		c.Seed = &seed.Int64
	}
	return &c, nil
}
