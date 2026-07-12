package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// CoverParams describes a stored cover image.
type CoverParams struct {
	ImagePath   string
	Width       int
	Height      int
	ContentHash string
}

// CreateCover inserts a cover_art row, deduping by content hash: if an image
// with the same bytes already exists, its id is returned and no row is added.
func (r *Repo) CreateCover(ctx context.Context, p CoverParams) (string, error) {
	if existingID, _, err := r.FindCoverByHash(ctx, p.ContentHash); err != nil {
		return "", err
	} else if existingID != "" {
		return existingID, nil
	}
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO cover_art(id, image_path, width, height, content_hash) VALUES(?,?,?,?,?)`,
		id, p.ImagePath, p.Width, p.Height, p.ContentHash)
	if err != nil {
		return "", err
	}
	return id, nil
}

// FindCoverByHash returns the id and image_path of a cover with the given hash,
// or ("","",nil) if none exists.
func (r *Repo) FindCoverByHash(ctx context.Context, hash string) (string, string, error) {
	if hash == "" {
		return "", "", nil
	}
	var id, path string
	err := r.db.QueryRowContext(ctx,
		`SELECT id, image_path FROM cover_art WHERE content_hash = ?`, hash).Scan(&id, &path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return id, path, nil
}

// GetCoverPath returns the stored image path for a cover id.
func (r *Repo) GetCoverPath(ctx context.Context, coverID string) (string, error) {
	var path string
	err := r.db.QueryRowContext(ctx, `SELECT image_path FROM cover_art WHERE id = ?`, coverID).Scan(&path)
	return path, err
}

// SetSongCover assigns a cover to a song. If the song has an album, the cover is
// recorded in album_covers and applied to every song of that artist+album (and,
// via Create, future ones). A song with no album gets a per-song cover only.
func (r *Repo) SetSongCover(ctx context.Context, songID, coverID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var artistID string
	var album sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT artist_id, album FROM songs WHERE id = ?`, songID).Scan(&artistID, &album)
	if err != nil {
		return err
	}

	if key := albumKey(album.String); key != "" {
		if err := setAlbumCoverTx(ctx, tx, artistID, key, coverID); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET cover_art_id = ? WHERE id = ?`, coverID, songID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// RemoveSongCover clears a song's cover. Mirroring SetSongCover, a song that
// belongs to an album is cleared album-wide: the album_covers mapping is dropped
// and cover_art_id is set NULL for every track of that artist+album. A song with
// no album gets its own cover cleared only. The cover_art rows are left in place —
// they are content-addressed and may still be referenced by other songs.
func (r *Repo) RemoveSongCover(ctx context.Context, songID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var artistID string
	var album sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT artist_id, album FROM songs WHERE id = ?`, songID).Scan(&artistID, &album)
	if err != nil {
		return err
	}

	if key := albumKey(album.String); key != "" {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM album_covers WHERE artist_id = ? AND album_key = ?`, artistID, key); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			// lower(trim(album)) mirrors albumKey / setAlbumCoverTx so siblings whose
			// stored album carries leading/trailing whitespace are cleared too.
			`UPDATE songs SET cover_art_id = NULL WHERE artist_id = ? AND lower(trim(album)) = ?`,
			artistID, key); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET cover_art_id = NULL WHERE id = ?`, songID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetAlbumCover maps a cover to an artist+album directly (no representative song
// needed) and applies it to every existing song of that album; future songs pick
// it up via the album_covers mapping. Used by the Studio album-cover flow, which
// already knows the artist+album. A blank album is rejected — album covers are
// keyed by album, and singles use per-song covers via SetSongCover.
func (r *Repo) SetAlbumCover(ctx context.Context, artistID, album, coverID string) error {
	key := albumKey(album)
	if key == "" {
		return errors.New("album is required")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := setAlbumCoverTx(ctx, tx, artistID, key, coverID); err != nil {
		return err
	}
	return tx.Commit()
}

// setAlbumCoverTx upserts the album_covers mapping and bulk-applies the cover to
// every song of the artist+album within an existing transaction. key must be a
// non-empty albumKey (lower-cased album).
func setAlbumCoverTx(ctx context.Context, tx *sql.Tx, artistID, key, coverID string) error {
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO album_covers(artist_id, album_key, cover_art_id) VALUES(?,?,?)
		 ON CONFLICT(artist_id, album_key) DO UPDATE SET cover_art_id = excluded.cover_art_id`,
		artistID, key, coverID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		// lower(trim(album)) mirrors albumKey so siblings whose stored album carries
		// leading/trailing whitespace (common in ID3 tags) still receive the cover.
		`UPDATE songs SET cover_art_id = ? WHERE artist_id = ? AND lower(trim(album)) = ?`,
		coverID, artistID, key); err != nil {
		return err
	}
	return nil
}

// albumCoverIDTx returns the mapped cover id for an (artist, album), or "".
func albumCoverIDTx(ctx context.Context, tx *sql.Tx, artistID, album string) (string, error) {
	key := albumKey(album)
	if key == "" {
		return "", nil
	}
	var coverID string
	err := tx.QueryRowContext(ctx,
		`SELECT cover_art_id FROM album_covers WHERE artist_id = ? AND album_key = ?`,
		artistID, key).Scan(&coverID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return coverID, err
}

func albumKey(album string) string {
	return strings.ToLower(strings.TrimSpace(album))
}
