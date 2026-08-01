package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// StudioRun is one completed Studio generation, kept so it can be reopened
// read-only later. Every field is serialized to the client except RowID, which
// is the keyset cursor the drawer pages with and is meaningless outside this
// process.
type StudioRun struct {
	ID              string   `json:"id"`
	Reference       string   `json:"reference"`
	ReferenceArtist string   `json:"referenceArtist"`
	ReferenceTitle  string   `json:"referenceTitle"`
	StylePrompt     string   `json:"stylePrompt"`
	Lyrics          string   `json:"lyrics"`
	CoverArtPrompt  string   `json:"coverArtPrompt"`
	Genres          []string `json:"genres"`
	Bands           []string `json:"bands"`
	Titles          []string `json:"titles"`
	Albums          []string `json:"albums"`
	CoverArtID      string   `json:"coverArtId"`
	RefineCount     int      `json:"refineCount"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`

	RowID int64 `json:"-"`
}

// defaultStudioRunLimit is the page size ListStudioRuns falls back to when the
// caller passes a non-positive limit. It matches the drawer's page size; the
// HTTP layer owns the real clamping.
const defaultStudioRunLimit = 25

const studioRunSelect = `SELECT rowid, id, reference, reference_artist, reference_title,
	style_prompt, lyrics, cover_art_prompt, genres, bands, titles, albums,
	COALESCE(coverart_id,''), refine_count, created_at, updated_at FROM studio_history`

// encodeStudioList encodes a string slice for a JSON TEXT column. A nil slice
// must become "[]" rather than "null", or the read side unmarshals to nil and
// the client sees null where it expects an array.
func encodeStudioList(v []string) string {
	if v == nil {
		v = []string{}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// decodeStudioList is the inverse. A malformed column yields an empty list
// rather than failing the whole read: one bad row must not make the drawer
// unopenable.
func decodeStudioList(s string) []string {
	out := []string{}
	if s == "" {
		return out
	}
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return []string{}
	}
	if out == nil {
		return []string{}
	}
	return out
}

func scanStudioRun(s interface{ Scan(...any) error }) (*StudioRun, error) {
	var r StudioRun
	var genres, bands, titles, albums string
	if err := s.Scan(&r.RowID, &r.ID, &r.Reference, &r.ReferenceArtist, &r.ReferenceTitle,
		&r.StylePrompt, &r.Lyrics, &r.CoverArtPrompt, &genres, &bands, &titles, &albums,
		&r.CoverArtID, &r.RefineCount, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	r.Genres, r.Bands = decodeStudioList(genres), decodeStudioList(bands)
	r.Titles, r.Albums = decodeStudioList(titles), decodeStudioList(albums)
	return &r, nil
}

// CreateStudioRun records a completed run. Called only after Generate returns,
// so there is no partial/failed state to represent.
func (r *Repo) CreateStudioRun(ctx context.Context, run StudioRun) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO studio_history(id, reference, reference_artist, reference_title,
			style_prompt, lyrics, cover_art_prompt, genres, bands, titles, albums)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		run.ID, run.Reference, run.ReferenceArtist, run.ReferenceTitle,
		run.StylePrompt, run.Lyrics, run.CoverArtPrompt,
		encodeStudioList(run.Genres), encodeStudioList(run.Bands),
		encodeStudioList(run.Titles), encodeStudioList(run.Albums))
	return err
}

// ListStudioRuns returns up to limit runs, newest first. beforeRowID is the
// keyset cursor: pass 0 for the first page, then the RowID of the last row you
// received. Keyset rather than OFFSET so a run written mid-scroll cannot shift
// the window and duplicate a row.
func (r *Repo) ListStudioRuns(ctx context.Context, limit int, beforeRowID int64) ([]StudioRun, error) {
	if limit <= 0 {
		limit = defaultStudioRunLimit
	}
	q := studioRunSelect + ` ORDER BY rowid DESC LIMIT ?`
	args := []any{limit}
	if beforeRowID > 0 {
		q = studioRunSelect + ` WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`
		args = []any{beforeRowID, limit}
	}
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StudioRun{}
	for rows.Next() {
		run, err := scanStudioRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, rows.Err()
}

// CountStudioRuns reports how many runs are stored, so the drawer can show
// "25 of N" without fetching the rest.
func (r *Repo) CountStudioRuns(ctx context.Context) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM studio_history`).Scan(&n)
	return n, err
}

// GetStudioRun returns one run in full, or (nil, nil) when absent.
func (r *Repo) GetStudioRun(ctx context.Context, id string) (*StudioRun, error) {
	run, err := scanStudioRun(r.db.QueryRowContext(ctx, studioRunSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return run, err
}

// UpdateStudioRunLyrics overwrites a run's saved lyrics. bumpRefine records that
// the change came from the refine endpoint; a hand edit passes false, because
// typing in the box is not a refine. A missing id is a no-op: the run may have
// been deleted while it was still on screen.
func (r *Repo) UpdateStudioRunLyrics(ctx context.Context, id, lyrics string, bumpRefine bool) error {
	q := `UPDATE studio_history SET lyrics=?, updated_at=datetime('now') WHERE id=?`
	if bumpRefine {
		q = `UPDATE studio_history SET lyrics=?, refine_count=refine_count+1,
			updated_at=datetime('now') WHERE id=?`
	}
	_, err := r.db.ExecContext(ctx, q, lyrics, id)
	return err
}

// UpdateStudioRunCoverArt attaches a generated cover image to a run. The image
// itself lives in studio_coverart and is only referenced here.
func (r *Repo) UpdateStudioRunCoverArt(ctx context.Context, id, coverArtID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE studio_history SET coverart_id=?, updated_at=datetime('now') WHERE id=?`,
		nullIfEmpty(coverArtID), id)
	return err
}

// DeleteStudioRun removes a run. Deleting one that is already gone is a no-op —
// the drawer may fire the same delete twice.
func (r *Repo) DeleteStudioRun(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM studio_history WHERE id=?`, id)
	return err
}
