package library

import "context"

// SongFile is the minimum the audio-info backfill needs to reopen a stored file.
type SongFile struct {
	ID       string
	FilePath string
}

// SongsMissingAudioInfo lists songs whose audio columns were never filled —
// everything imported before migration 0006, since a SQL migration can't read the
// MP3s. The backfill (httpapi) reopens each file and calls SetAudioInfo.
//
// Keyed on sample_rate IS NULL alone: the three columns are always written
// together, so any one of them answers for all three, and a file that failed to
// decode is stored as 0 rather than NULL — that's what stops it being retried on
// every start.
func (r *Repo) SongsMissingAudioInfo(ctx context.Context) ([]SongFile, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, file_path FROM songs WHERE sample_rate IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SongFile{}
	for rows.Next() {
		var f SongFile
		if err := rows.Scan(&f.ID, &f.FilePath); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SetAudioInfo records a song's decoded audio properties. Zeroes are meaningful:
// they mark a file we tried and couldn't decode, so it settles at "—" in the UI
// instead of being rescanned forever.
func (r *Repo) SetAudioInfo(ctx context.Context, songID string, sampleRate, channels, bitrateKbps int) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE songs SET sample_rate = ?, channels = ?, bitrate_kbps = ? WHERE id = ?`,
		sampleRate, channels, bitrateKbps, songID)
	return err
}
