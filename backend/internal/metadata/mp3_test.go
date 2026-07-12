package metadata

import (
	"bytes"
	"os"
	"testing"
)

func openFixture(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Open("testdata/sample.mp3")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestParse_readsTags(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Title != "Test Song" {
		t.Errorf("Title = %q, want Test Song", got.Title)
	}
	if got.Artist != "Test Artist" {
		t.Errorf("Artist = %q, want Test Artist", got.Artist)
	}
	if got.Album != "Test Album" {
		t.Errorf("Album = %q, want Test Album", got.Album)
	}
	if got.Year != 2020 {
		t.Errorf("Year = %d, want 2020", got.Year)
	}
	if got.TrackNo != 3 {
		t.Errorf("TrackNo = %d, want 3", got.TrackNo)
	}
}

func TestParse_splitsMultiGenre(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(got.Genres) != 2 || got.Genres[0] != "Synthwave" || got.Genres[1] != "Dream Pop" {
		t.Fatalf("Genres = %#v, want [Synthwave Dream Pop]", got.Genres)
	}
}

func TestParse_decodesDuration(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// Fixture is a 2.0s tone; allow encoder padding slack.
	if got.DurationMS < 1850 || got.DurationMS > 2150 {
		t.Fatalf("DurationMS = %d, want ~2000", got.DurationMS)
	}
}

// TestParse_extractsEmbeddedCover round-trips an APIC frame through WriteTags:
// embed a cover, then Parse must surface its bytes and MIME type.
func TestParse_extractsEmbeddedCover(t *testing.T) {
	path := copyFixture(t)
	cover := []byte("\xFF\xD8\xFF-front-cover-bytes-stored-verbatim")
	if err := WriteTags(path, WriteableTags{
		Title: "T", Artist: "A", Album: "Al", Genres: []string{"Ambient"},
		CoverBytes: cover, CoverMIME: "image/png",
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	got, err := Parse(f)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !bytes.Equal(got.CoverBytes, cover) {
		t.Fatalf("CoverBytes = %q, want %q", got.CoverBytes, cover)
	}
	if got.CoverMIME != "image/png" {
		t.Errorf("CoverMIME = %q, want image/png", got.CoverMIME)
	}
}

// TestParse_noCoverLeavesFieldsEmpty guards the placeholder path: a file without
// embedded art yields empty cover fields.
func TestParse_noCoverLeavesFieldsEmpty(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(got.CoverBytes) != 0 || got.CoverMIME != "" {
		t.Fatalf("expected no cover, got %d bytes / mime %q", len(got.CoverBytes), got.CoverMIME)
	}
}
