package studio

import (
	"strings"
	"testing"

	"github.com/trick77/music/internal/library"
)

// The genre list is joined into the prompt, so blank entries must be dropped
// before the join — joining first turns []string{"  ", ""} into "  , ", which
// survives a TrimSpace check and reaches the model as punctuation-only genres.
func TestAlbumCoverPromptUserPrompt_blankGenres(t *testing.T) {
	cases := []struct {
		name   string
		genres []string
		want   string
	}{
		{"no genres", nil, "(unknown)"},
		{"empty slice", []string{}, "(unknown)"},
		{"single blank", []string{"   "}, "(unknown)"},
		{"several blanks", []string{"  ", ""}, "(unknown)"},
		{"blank mixed with real", []string{"", "Shoegaze", "   "}, "Shoegaze"},
		{"surrounding space trimmed", []string{"  Dream Pop  "}, "Dream Pop"},
		{"real genres joined", []string{"Shoegaze", "Dream Pop"}, "Shoegaze, Dream Pop"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := albumCoverPromptUserPrompt("Vesper Lake", "Nightbird", tc.genres, nil)

			want := "Genre(s): " + tc.want
			if !strings.Contains(got, want) {
				t.Errorf("prompt missing %q:\n%s", want, got)
			}
			// A dangling separator is the specific failure this guards against.
			for _, bad := range []string{"Genre(s):  ,", "Genre(s): ,", "Genre(s): \n"} {
				if strings.Contains(got, bad) {
					t.Errorf("prompt has a malformed genre line %q:\n%s", bad, got)
				}
			}
		})
	}
}

// Lyrics are appended after the genre line; the blank-genre handling must not
// disturb that.
func TestAlbumCoverPromptUserPrompt_includesLyrics(t *testing.T) {
	got := albumCoverPromptUserPrompt("Vesper Lake", "Nightbird", []string{"Shoegaze"},
		[]library.SongLyric{{Title: "Drift", Lyrics: "first line"}})

	for _, want := range []string{"Artist: Vesper Lake", "Album: Nightbird", "Genre(s): Shoegaze", "Lyrics:", "Drift", "first line"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q:\n%s", want, got)
		}
	}
}
