package metadata

import (
	"io"
	"os"
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
	// CoverBytes, when non-empty, is embedded as the front-cover attached picture
	// (APIC). CoverMIME is its MIME type (e.g. "image/jpeg"). Empty CoverBytes
	// leaves any existing embedded art untouched.
	CoverBytes []byte
	CoverMIME  string
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

	if len(t.CoverBytes) > 0 {
		// Replace any existing attached picture(s) with the app's cover so the
		// download reflects the current cover mapping, not stale embedded art.
		tag.DeleteFrames(tag.CommonID("Attached picture"))
		mime := t.CoverMIME
		if mime == "" {
			mime = "image/jpeg"
		}
		tag.AddAttachedPicture(id3v2.PictureFrame{
			Encoding:    tag.DefaultEncoding(),
			MimeType:    mime,
			PictureType: id3v2.PTFrontCover,
			Description: "Front cover",
			Picture:     t.CoverBytes,
		})
	}

	return tag.Save()
}

// StampTags copies the MP3 at srcPath to dstPath and writes the given tags into
// the copy, leaving the source untouched. The DB is the source of truth for tags;
// downloads use this to bake the current tags into a throwaway copy without ever
// mutating the stored file. The caller owns dstPath's lifetime (typically a temp
// file it deletes after serving).
func StampTags(srcPath, dstPath string, t WriteableTags) error {
	if err := copyFile(srcPath, dstPath); err != nil {
		return err
	}
	return WriteTags(dstPath, t)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
