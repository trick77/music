package httpapi

import (
	"context"
	"log/slog"

	"github.com/trick77/music/internal/metadata"
)

// backfillAudioInfo fills sample rate / channels / bitrate for songs imported
// before migration 0006. The migration adds the columns but can't populate them —
// only the MP3s know, and SQL can't read files — so the values are recovered here
// by reopening each stored file once.
//
// Runs in the background off a goroutine (see New): a library of thousands would
// otherwise hold up the listener, and nothing about the app is broken while it's
// pending — an unfilled row simply renders "—", exactly as an undecodable
// duration always has.
//
// Every failure is terminal-but-benign: a missing or corrupt file is recorded as
// zeroes, which settles the row so it isn't retried on every start. Songs
// uploaded from now on are filled at import and never appear here.
func (h *songHandlers) backfillAudioInfo(ctx context.Context) {
	pending, err := h.repo.SongsMissingAudioInfo(ctx)
	if err != nil {
		slog.Warn("audio-info backfill: cannot list songs", "err", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	slog.Info("audio-info backfill: starting", "songs", len(pending))

	var filled, failed int
	for _, s := range pending {
		if ctx.Err() != nil {
			slog.Info("audio-info backfill: cancelled", "filled", filled, "remaining", len(pending)-filled-failed)
			return
		}
		a, err := h.readAudioInfo(s.FilePath)
		if err != nil {
			// Store zeroes anyway: the row settles at "—" rather than being rescanned
			// on every boot for a file that will never decode.
			failed++
			slog.Warn("audio-info backfill: undecodable, recording as unknown", "song", s.ID, "err", err)
		} else {
			filled++
		}
		if err := h.repo.SetAudioInfo(ctx, s.ID, a.SampleRate, a.Channels, a.BitrateKbps); err != nil {
			slog.Warn("audio-info backfill: cannot save", "song", s.ID, "err", err)
		}
	}
	slog.Info("audio-info backfill: done", "filled", filled, "undecodable", failed)
}

// readAudioInfo reopens a stored file and re-reads its audio properties. Returns
// the zero Audio alongside any error, so callers can persist the result either way.
func (h *songHandlers) readAudioInfo(relPath string) (metadata.Audio, error) {
	f, err := h.media.Open(relPath)
	if err != nil {
		return metadata.Audio{}, err
	}
	defer f.Close()
	tags, err := metadata.Parse(f)
	if err != nil {
		return metadata.Audio{}, err
	}
	return tags.Audio, nil
}
