package metadata

import (
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

// trackFrame reads the raw TRCK ("Track number/Position in set") text, which
// carries the "N/Y" total that Parse() deliberately discards.
func trackFrame(t *testing.T, path string) string {
	t.Helper()
	tag, err := id3v2.Open(path, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer tag.Close()
	return tag.GetTextFrame(tag.CommonID("Track number/Position in set")).Text
}

func TestWriteTags_trackNumberFormat(t *testing.T) {
	t.Run("with total writes N/Y", func(t *testing.T) {
		path := copyFixture(t)
		if err := WriteTags(path, WriteableTags{TrackNo: 3, TrackTotal: 3}); err != nil {
			t.Fatalf("WriteTags: %v", err)
		}
		if got := trackFrame(t, path); got != "3/3" {
			t.Fatalf("TRCK = %q, want %q", got, "3/3")
		}
	})

	t.Run("no total writes bare number", func(t *testing.T) {
		path := copyFixture(t)
		if err := WriteTags(path, WriteableTags{TrackNo: 3}); err != nil {
			t.Fatalf("WriteTags: %v", err)
		}
		if got := trackFrame(t, path); got != "3" {
			t.Fatalf("TRCK = %q, want %q", got, "3")
		}
	})

	t.Run("zero track deletes the frame", func(t *testing.T) {
		path := copyFixture(t)
		if err := WriteTags(path, WriteableTags{TrackNo: 0, TrackTotal: 5}); err != nil {
			t.Fatalf("WriteTags: %v", err)
		}
		if got := trackFrame(t, path); got != "" {
			t.Fatalf("TRCK = %q, want empty (frame deleted)", got)
		}
	})
}
