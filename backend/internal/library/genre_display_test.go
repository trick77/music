package library

import "testing"

func TestGenreDisplay(t *testing.T) {
	cases := map[string]string{
		"dream pop":     "Dream Pop",
		"synthwave":     "Synthwave",
		"drum and bass": "Drum and Bass",
		"r&b":           "R&B",
		"indie-rock":    "Indie-Rock",
		"trip-hop":      "Trip-Hop",
		"lo-fi":         "Lo-Fi",
		"":              "",
	}
	for in, want := range cases {
		if got := GenreDisplay(in); got != want {
			t.Errorf("GenreDisplay(%q) = %q, want %q", in, got, want)
		}
	}
}
