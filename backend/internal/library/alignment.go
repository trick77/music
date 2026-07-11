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

// StartAlignment atomically claims the song's alignment slot: it inserts (or resets)
// the row to 'generating', clearing any prior data/error/engine, but ONLY when no
// alignment is already generating. started is false when a job is already in flight
// (the row stays untouched), so the caller can reject a concurrent request without a
// separate read — closing the check-then-act race two POSTs could otherwise slip
// through. The WHERE guard on the upsert makes the claim a single atomic statement.
func (r *Repo) StartAlignment(ctx context.Context, songID string) (started bool, err error) {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO song_alignment(song_id, status) VALUES(?, 'generating')
		 ON CONFLICT(song_id) DO UPDATE SET status='generating', data=NULL, error=NULL, engine=NULL
		   WHERE song_alignment.status <> 'generating'`,
		songID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
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
