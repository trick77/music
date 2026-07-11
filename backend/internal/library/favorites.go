package library

import "context"

// ListFavorites returns the song ids the given user has favorited, oldest first.
// Always returns a non-nil slice so callers/JSON render an empty list, not null.
func (r *Repo) ListFavorites(ctx context.Context, username string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT song_id FROM favorites WHERE username = ? ORDER BY created_at, rowid`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// AddFavorite favorites a song for a user. Idempotent: re-favoriting is a no-op.
func (r *Repo) AddFavorite(ctx context.Context, username, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO favorites(username, song_id) VALUES(?,?)
		 ON CONFLICT(username, song_id) DO NOTHING`, username, songID)
	return err
}

// RemoveFavorite unfavorites a song for a user. Idempotent: removing a
// non-favorite is a no-op.
func (r *Repo) RemoveFavorite(ctx context.Context, username, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM favorites WHERE username = ? AND song_id = ?`, username, songID)
	return err
}
