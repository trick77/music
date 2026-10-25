package library

import (
	"context"
	"testing"
)

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
