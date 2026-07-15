package library

import (
	"context"
	"testing"
)

// Rows created before migration 0006 have NULL audio info. The backfill finds them
// by asking for exactly that set, so this is the query that decides whether an old
// library ever gets its Info tab populated.
func TestSongsMissingAudioInfo_FindsOnlyUnfilledRows(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	old := seedSong(t, r, "Old")   // seeded with no audio info — the pre-0006 shape
	done := seedSong(t, r, "Done") // filled in below

	if err := r.SetAudioInfo(ctx, done, 44100, 2, 128); err != nil {
		t.Fatalf("SetAudioInfo: %v", err)
	}

	missing, err := r.SongsMissingAudioInfo(ctx)
	if err != nil {
		t.Fatalf("SongsMissingAudioInfo: %v", err)
	}
	if len(missing) != 1 {
		t.Fatalf("got %d rows, want 1 — only the unfilled song", len(missing))
	}
	if missing[0].ID != old {
		t.Errorf("ID = %q, want the unfilled song %q", missing[0].ID, old)
	}
	if missing[0].FilePath == "" {
		t.Error("FilePath is empty — the backfill needs it to open the file")
	}
	_ = done
}

func TestSetAudioInfo_RoundTrips(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id := seedSong(t, r, "Track")

	if err := r.SetAudioInfo(ctx, id, 48000, 1, 192); err != nil {
		t.Fatalf("SetAudioInfo: %v", err)
	}
	got, err := r.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.SampleRate != 48000 || got.Channels != 1 || got.BitrateKbps != 192 {
		t.Errorf("got %d/%d/%d, want 48000/1/192", got.SampleRate, got.Channels, got.BitrateKbps)
	}
}

// A file we can't decode must not be retried forever on every boot. Zeroes are
// stored, so the row stops being "missing" and the UI renders "—".
func TestSetAudioInfo_ZeroesSettleAnUndecodableFile(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id := seedSong(t, r, "Broken")

	if err := r.SetAudioInfo(ctx, id, 0, 0, 0); err != nil {
		t.Fatalf("SetAudioInfo: %v", err)
	}
	missing, err := r.SongsMissingAudioInfo(ctx)
	if err != nil {
		t.Fatalf("SongsMissingAudioInfo: %v", err)
	}
	for _, m := range missing {
		if m.ID == id {
			t.Fatal("an undecodable song is still reported as missing — the backfill would retry it every start")
		}
	}
}

// A song with no audio info reads as zeroes rather than failing the scan.
func TestGet_NullAudioInfoScansAsZero(t *testing.T) {
	r := newRepo(t)
	id := seedSong(t, r, "Unfilled")
	got, err := r.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.SampleRate != 0 || got.Channels != 0 || got.BitrateKbps != 0 {
		t.Errorf("got %d/%d/%d, want zeroes for NULL columns", got.SampleRate, got.Channels, got.BitrateKbps)
	}
}
