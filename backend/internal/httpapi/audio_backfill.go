package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/trick77/music/internal/metadata"
)

// errUnreadable marks a failure to OPEN a stored file, as distinct from a failure
// to decode one. The difference decides whether a row settles or is retried, and
// getting it wrong is destructive: "file not found" is exactly what a media volume
// that hasn't mounted yet looks like, so treating it as permanent would zero the
// whole library on one unlucky boot and never recover.
var errUnreadable = errors.New("cannot open stored file")

// backfillAudioInfo fills sample rate / channels / bitrate for songs imported
// before migration 0006. The migration adds the columns but can't populate them —
// only the MP3s know, and SQL can't read files — so the values are recovered here
// by reopening each stored file once.
//
// Runs in the background off a goroutine (see New): a library of thousands would
// otherwise hold up the listener, and nothing about the app is broken while it's
// pending — an unfilled row simply renders "—", exactly as an undecodable
// duration always has. It runs to completion; there is no cancellation path,
// because New has no lifecycle to hang one off.
//
// Failures are split deliberately, and the split is the important part:
//
//   - CANNOT OPEN (missing, permissions, volume not mounted) → leave the row NULL
//     and retry on the next start. A not-yet-mounted media volume makes every file
//     look missing; settling those would zero the entire library in seconds and
//     never recover, since a 0 row is never pending again.
//   - CANNOT DECODE (opened fine, isn't a readable MP3) → store zeroes. This one
//     really is permanent, so the row settles at "—" instead of being rescanned on
//     every boot.
//
// Songs uploaded from now on are filled at import and never appear here.
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

	var filled, undecodable, deferred int
	for _, s := range pending {
		a, err := h.readAudioInfo(s.FilePath)
		switch {
		case errors.Is(err, errUnreadable):
			// Might just be a volume that isn't up yet — leave it pending.
			deferred++
			slog.Warn("audio-info backfill: unreadable, will retry on next start", "song", s.ID, "err", err)
			continue
		case err != nil:
			undecodable++
			slog.Warn("audio-info backfill: undecodable, recording as unknown", "song", s.ID, "err", err)
		default:
			filled++
		}
		if err := h.repo.SetAudioInfo(ctx, s.ID, a.SampleRate, a.Channels, a.BitrateKbps); err != nil {
			slog.Warn("audio-info backfill: cannot save", "song", s.ID, "err", err)
		}
	}
	slog.Info("audio-info backfill: done", "filled", filled, "undecodable", undecodable, "deferred", deferred)
}

// readAudioInfo reopens a stored file and re-reads its audio properties. An open
// failure is wrapped in errUnreadable so the caller can tell "come back later"
// apart from "this will never decode"; a parse failure is returned bare, and is
// permanent — the same bytes won't parse next boot either.
func (h *songHandlers) readAudioInfo(relPath string) (metadata.Audio, error) {
	f, err := h.media.Open(relPath)
	if err != nil {
		return metadata.Audio{}, fmt.Errorf("%w: %w", errUnreadable, err)
	}
	defer f.Close()
	tags, err := metadata.Parse(f)
	if err != nil {
		return metadata.Audio{}, err
	}
	return tags.Audio, nil
}
