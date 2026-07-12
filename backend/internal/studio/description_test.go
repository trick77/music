package studio

import (
	"context"
	"testing"

	"github.com/trick77/music/internal/library"
)

func TestPlaylistDescriptions_parsesThreeTones(t *testing.T) {
	json := `{"punchy":"Windows down.","evocative":"Sun-bleached highway pop.","factual":"12 synthwave songs."}`
	w := NewDescriptionWriter(fakeChat{reply: json})
	got, err := w.PlaylistDescriptions(context.Background(), "Road Trip", []library.PlaylistTrackBrief{
		{Title: "Nightcall", Artist: "Kavinsky", Genres: []string{"synthwave"}},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Punchy == "" || got.Evocative == "" || got.Factual == "" {
		t.Fatalf("empty tone in %+v", got)
	}
	if got.Evocative != "Sun-bleached highway pop." {
		t.Fatalf("got %q", got.Evocative)
	}
}

func TestPlaylistDescriptions_errorsOnEmptyTone(t *testing.T) {
	w := NewDescriptionWriter(fakeChat{reply: `{"punchy":"x","evocative":"","factual":"y"}`})
	if _, err := w.PlaylistDescriptions(context.Background(), "P", nil); err == nil {
		t.Fatal("expected error on empty tone")
	}
}
