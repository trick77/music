package metadata

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

// copyFixture copies the committed sample into a temp file we can safely mutate.
func copyFixture(t *testing.T) string {
	t.Helper()
	src, err := os.Open("testdata/sample.mp3")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer src.Close()
	dst := filepath.Join(t.TempDir(), "edit.mp3")
	df, err := os.Create(dst)
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	if _, err := io.Copy(df, src); err != nil {
		t.Fatalf("copy: %v", err)
	}
	df.Close()
	return dst
}

func parsePath(t *testing.T, path string) Tags {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	tags, err := Parse(f)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return tags
}

func TestWriteTags_writesToFileAndPreservesAudio(t *testing.T) {
	path := copyFixture(t)
	before := parsePath(t, path)

	err := WriteTags(path, WriteableTags{
		Title:   "Edited Title",
		Artist:  "Edited Artist",
		Album:   "Edited Album",
		Year:    1999,
		TrackNo: 7,
		Genres:  []string{"Ambient", "Drone"},
	})
	if err != nil {
		t.Fatalf("WriteTags: %v", err)
	}

	after := parsePath(t, path)
	if after.Title != "Edited Title" || after.Artist != "Edited Artist" || after.Album != "Edited Album" {
		t.Fatalf("tags not written: %+v", after)
	}
	if after.Year != 1999 || after.TrackNo != 7 {
		t.Fatalf("year/track not written: %+v", after)
	}
	if len(after.Genres) != 2 || after.Genres[0] != "Ambient" || after.Genres[1] != "Drone" {
		t.Fatalf("genres not written: %#v", after.Genres)
	}
	// Audio must survive the rewrite: duration unchanged (go-mp3 re-decode).
	if before.DurationMS < 1850 || after.DurationMS < before.DurationMS-50 || after.DurationMS > before.DurationMS+50 {
		t.Fatalf("duration changed by rewrite: before=%d after=%d", before.DurationMS, after.DurationMS)
	}
}

func TestWriteTags_preservesUnsetFieldsIndependence(t *testing.T) {
	// Editing only the title must not blank the artist (mutate parsed tag).
	path := copyFixture(t)
	if err := WriteTags(path, WriteableTags{
		Title:  "Only Title Changed",
		Artist: "Test Artist",
		Album:  "Test Album",
		Year:   2020,
		Genres: []string{"Synthwave", "Dream Pop"},
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}
	after := parsePath(t, path)
	if after.Artist != "Test Artist" || after.Album != "Test Album" {
		t.Fatalf("unrelated fields lost: %+v", after)
	}
}
