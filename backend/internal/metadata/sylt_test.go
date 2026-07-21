package metadata

import (
	"bytes"
	"os"
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

func TestSyncedLyricsFrame_SizeMatchesWriteTo(t *testing.T) {
	cases := [][]SyncedWord{
		{},
		{{Text: "\nNever", TimeMs: 12000}, {Text: " gonna", TimeMs: 12400}},
		{{Text: "\nRésumé café", TimeMs: 1000}, {Text: " naïve", TimeMs: 2000}}, // multibyte
		{{Text: "\n日本語", TimeMs: 3000}},                                         // non-latin
	}
	for i, words := range cases {
		f := NewSyncedLyricsFrame("eng", words)
		var buf bytes.Buffer
		n, err := f.WriteTo(&buf)
		if err != nil {
			t.Fatalf("case %d WriteTo: %v", i, err)
		}
		if int(n) != f.Size() {
			t.Fatalf("case %d: WriteTo wrote %d bytes but Size()=%d", i, n, f.Size())
		}
		if buf.Len() != f.Size() {
			t.Fatalf("case %d: buffer len %d != Size() %d", i, buf.Len(), f.Size())
		}
	}
}

func TestSyncedLyricsFrame_RoundTripParsesClean(t *testing.T) {
	src := "testdata/sample.mp3"
	dst := t.TempDir() + "/out.mp3"
	if err := copyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	tag, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatal(err)
	}
	tag.SetTitle("Round Trip")
	tag.AddFrame("SYLT", NewSyncedLyricsFrame("eng", []SyncedWord{
		{Text: "\nHello", TimeMs: 1000}, {Text: " world", TimeMs: 1500},
	}))
	if err := tag.Save(); err != nil {
		t.Fatal(err)
	}
	tag.Close()

	reopened, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatalf("re-open after SYLT stamp failed to parse: %v", err)
	}
	defer reopened.Close()
	if reopened.Title() != "Round Trip" {
		t.Fatalf("title frame lost after SYLT stamp: %q", reopened.Title())
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatal(err)
	}
}
