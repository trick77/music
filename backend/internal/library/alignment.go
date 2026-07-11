package library

import (
	"context"
	"database/sql"
	"errors"
)

// Alignment is a stored word-timing row. The server-only failure reason is
// intentionally not carried here — GetAlignment is used to build client responses.
type Alignment struct {
	SongID    string
	Status    string
	Engine    string
	Data      string // JSON timings; empty until ready
	CreatedAt string
}

// UpsertGeneratingAlignment creates or resets the song's alignment row to the
// 'generating' state, clearing any prior data/error/engine so a re-run starts clean.
func (r *Repo) UpsertGeneratingAlignment(ctx context.Context, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO song_alignment(song_id, status) VALUES(?, 'generating')
		 ON CONFLICT(song_id) DO UPDATE SET status='generating', data=NULL, error=NULL, engine=NULL`,
		songID)
	return err
}

// MarkAlignmentReady records the timings JSON + engine and clears any prior error.
func (r *Repo) MarkAlignmentReady(ctx context.Context, songID, engine, data string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='ready', engine=?, data=?, error=NULL WHERE song_id=?`,
		engine, data, songID)
	return err
}

// MarkAlignmentFailed records a terminal failure with a server-only reason.
func (r *Repo) MarkAlignmentFailed(ctx context.Context, songID, reason string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='failed', error=? WHERE song_id=?`, reason, songID)
	return err
}

// GetAlignment returns the song's alignment row, or (nil, nil) if none exists.
func (r *Repo) GetAlignment(ctx context.Context, songID string) (*Alignment, error) {
	var a Alignment
	var engine, data sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT song_id, status, engine, data, created_at FROM song_alignment WHERE song_id=?`, songID).
		Scan(&a.SongID, &a.Status, &engine, &data, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.Engine = engine.String
	a.Data = data.String
	return &a, nil
}

// FailOrphanedAlignments flips any 'generating' alignment rows to 'failed' on boot —
// the alignment goroutine cannot survive a restart, mirroring FailOrphanedGenerating.
func (r *Repo) FailOrphanedAlignments(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='failed', error='alignment interrupted by a restart' WHERE status='generating'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
