package metadata

import (
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

// usltCount opens the file and counts USLT frames, so we can prove the writer
// never leaves duplicates.
func usltCount(t *testing.T, path string) int {
	t.Helper()
	tag, err := id3v2.Open(path, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer tag.Close()
	return len(tag.GetFrames(tag.CommonID("Unsynchronised lyrics/text transcription")))
}

func TestWriteTags_writesAndReadsLyrics(t *testing.T) {
	path := copyFixture(t)

	const lyrics = "Line one\nLine two (ooh)"
	if err := WriteTags(path, WriteableTags{Title: "T", Artist: "A", Lyrics: lyrics}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}

	if got := parsePath(t, path).Lyrics; got != lyrics {
		t.Fatalf("lyrics round-trip mismatch: got %q want %q", got, lyrics)
	}
	if n := usltCount(t, path); n != 1 {
		t.Fatalf("expected 1 USLT frame, got %d", n)
	}
}

func TestWriteTags_resaveDoesNotDuplicateLyrics(t *testing.T) {
	path := copyFixture(t)

	for i := 0; i < 3; i++ {
		if err := WriteTags(path, WriteableTags{Title: "T", Artist: "A", Lyrics: "Same words"}); err != nil {
			t.Fatalf("WriteTags #%d: %v", i, err)
		}
	}
	if n := usltCount(t, path); n != 1 {
		t.Fatalf("repeated saves left %d USLT frames, want 1", n)
	}
}

func TestWriteTags_emptyLyricsRemovesFrame(t *testing.T) {
	path := copyFixture(t)

	if err := WriteTags(path, WriteableTags{Title: "T", Artist: "A", Lyrics: "To be cleared"}); err != nil {
		t.Fatalf("WriteTags (set): %v", err)
	}
	if n := usltCount(t, path); n != 1 {
		t.Fatalf("setup: expected 1 USLT frame, got %d", n)
	}

	// Clearing the lyrics must delete the frame, not leave stale words baked in.
	if err := WriteTags(path, WriteableTags{Title: "T", Artist: "A", Lyrics: ""}); err != nil {
		t.Fatalf("WriteTags (clear): %v", err)
	}
	if n := usltCount(t, path); n != 0 {
		t.Fatalf("cleared lyrics left %d USLT frames, want 0", n)
	}
	if got := parsePath(t, path).Lyrics; got != "" {
		t.Fatalf("cleared lyrics still read back as %q", got)
	}
}

func TestCleanLyrics(t *testing.T) {
	cases := []struct{ in, want string }{
		// A section header on its own line collapses to a single blank line, which
		// nicely separates the stanzas it used to label.
		{"[Verse]\nHello world\n[Chorus]\nSing along", "Hello world\n\nSing along"},
		{"Keep (ooh) the ad-libs", "Keep (ooh) the ad-libs"},
		{"[Intro]\n\n\n\nWord", "Word"},
		{"Trailing spaces   \nNext", "Trailing spaces\nNext"},
		{"", ""},
	}
	for _, c := range cases {
		if got := cleanLyrics(c.in); got != c.want {
			t.Errorf("cleanLyrics(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
