package metadata

import (
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

func TestWriteTags_WritesSYLTWhenSynced(t *testing.T) {
	src := "testdata/sample.mp3"
	dst := t.TempDir() + "/out.mp3"
	err := StampTags(src, dst, WriteableTags{
		Title:  "T",
		Artist: "A",
		Lyrics: "Hello world",
		Synced: []SyncedWord{{Text: "\nHello", TimeMs: 1000}, {Text: " world", TimeMs: 1500}},
	})
	if err != nil {
		t.Fatal(err)
	}
	tag, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tag.Close()
	if frames := tag.GetFrames("SYLT"); len(frames) != 1 {
		t.Fatalf("want exactly 1 SYLT frame, got %d", len(frames))
	}
	// USLT (plain lyrics) still present alongside SYLT.
	if tag.GetLastFrame(tag.CommonID("Unsynchronised lyrics/text transcription")) == nil {
		t.Fatalf("USLT frame missing")
	}
}

func TestWriteTags_NoSYLTWhenEmpty(t *testing.T) {
	src := "testdata/sample.mp3"
	dst := t.TempDir() + "/out.mp3"
	if err := StampTags(src, dst, WriteableTags{Title: "T", Artist: "A"}); err != nil {
		t.Fatal(err)
	}
	tag, _ := id3v2.Open(dst, id3v2.Options{Parse: true})
	defer tag.Close()
	if frames := tag.GetFrames("SYLT"); len(frames) != 0 {
		t.Fatalf("want no SYLT frame, got %d", len(frames))
	}
}
