package metadata

import (
	"strconv"
	"strings"

	id3v2 "github.com/bogem/id3v2/v2"
)

// WriteableTags is the editable ID3 metadata written back to a file.
type WriteableTags struct {
	Title   string
	Artist  string
	Album   string
	Year    int
	TrackNo int
	Genres  []string
}

// WriteTags opens the MP3 at path, mutates its existing ID3v2 tag in place, and
// saves it. bogem/id3v2 Save() writes to a sibling temp file and atomically
// renames it over the original, so a crash cannot corrupt the only audio copy;
// mutating the *parsed* tag preserves frames we don't touch (e.g. album-artist,
// comment, cover art).
func WriteTags(path string, t WriteableTags) error {
	tag, err := id3v2.Open(path, id3v2.Options{Parse: true})
	if err != nil {
		return err
	}
	defer tag.Close()

	tag.SetTitle(t.Title)
	tag.SetArtist(t.Artist)
	if strings.TrimSpace(t.Album) != "" {
		tag.SetAlbum(t.Album)
	} else {
		tag.DeleteFrames(tag.CommonID("Album/Movie/Show title"))
	}
	if t.Year > 0 {
		tag.SetYear(strconv.Itoa(t.Year))
	} else {
		tag.DeleteFrames(tag.CommonID("Year"))
	}
	trackID := tag.CommonID("Track number/Position in set")
	if t.TrackNo > 0 {
		tag.AddTextFrame(trackID, tag.DefaultEncoding(), strconv.Itoa(t.TrackNo))
	} else {
		tag.DeleteFrames(trackID)
	}
	tag.SetGenre(strings.Join(t.Genres, "; "))

	return tag.Save()
}
