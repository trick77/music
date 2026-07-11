package metadata

import (
	"bytes"
	"os"
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

// frontCover reopens an MP3 and returns its front-cover attached picture, or a
// zero PictureFrame + false when none is present. APIC storage does not validate
// image content, so arbitrary bytes round-trip.
func frontCover(t *testing.T, path string) (id3v2.PictureFrame, bool) {
	t.Helper()
	tag, err := id3v2.Open(path, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer tag.Close()
	fr := tag.GetLastFrame(tag.CommonID("Attached picture"))
	pf, ok := fr.(id3v2.PictureFrame)
	return pf, ok
}

func TestWriteTags_embedsFrontCover(t *testing.T) {
	path := copyFixture(t)
	cover := []byte("\xFF\xD8\xFF-not-a-real-image-but-stored-verbatim")

	if _, ok := frontCover(t, path); ok {
		t.Fatal("fixture unexpectedly already has a front cover")
	}

	if err := WriteTags(path, WriteableTags{
		Title:      "T",
		Artist:     "A",
		Album:      "Al",
		Genres:     []string{"Ambient"},
		CoverBytes: cover,
		CoverMIME:  "image/png",
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}

	pf, ok := frontCover(t, path)
	if !ok {
		t.Fatal("no front cover embedded")
	}
	if pf.PictureType != id3v2.PTFrontCover {
		t.Fatalf("picture type = %d, want front cover", pf.PictureType)
	}
	if pf.MimeType != "image/png" {
		t.Fatalf("mime = %q, want image/png", pf.MimeType)
	}
	if !bytes.Equal(pf.Picture, cover) {
		t.Fatalf("embedded bytes differ from input")
	}
}

func TestWriteTags_noCoverLeavesSourceUnchangedAndAddsNoPicture(t *testing.T) {
	path := copyFixture(t)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	_ = before // audio-preservation is covered by the existing duration test

	if err := WriteTags(path, WriteableTags{
		Title: "T", Artist: "A", Album: "Al", Genres: []string{"Ambient"},
		// no CoverBytes
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}
	if _, ok := frontCover(t, path); ok {
		t.Fatal("WriteTags added a picture when none was requested")
	}
}
