// Package metadata parses MP3 ID3 tags and decodes playback duration.
package metadata

import (
	"io"
	"regexp"
	"strings"

	"github.com/dhowden/tag"
	"github.com/hajimehoshi/go-mp3"
)

// genreDelimiter is the canonical multi-genre separator (spec §10), e.g.
// "Synthwave; Dream Pop". Only this delimiter is used — commas and slashes
// appear inside legitimate genre names ("Drum & Bass", "Rock/Pop").
const genreDelimiter = ";"

// Tags is the metadata extracted from an uploaded MP3.
type Tags struct {
	Title      string
	Artist     string
	Album      string
	Year       int
	TrackNo    int
	Genres     []string
	Lyrics     string
	DurationMS int64
	// Audio properties of the encoded stream (see audio.go). Zeroed, like
	// DurationMS, when the file can't be decoded.
	Audio
	// CoverBytes/CoverMIME hold the embedded front-cover attached picture (APIC),
	// when the file carries one. Empty when the file has no embedded art.
	CoverBytes []byte
	CoverMIME  string
}

// Parse reads ID3 metadata from r and decodes its duration. Tag reading errors
// are returned; duration decode failures are non-fatal (DurationMS stays 0) so
// an odd-but-playable file still imports.
func Parse(r io.ReadSeeker) (Tags, error) {
	var out Tags
	m, err := tag.ReadFrom(r)
	if err != nil {
		return out, err
	}
	out.Title = strings.TrimSpace(m.Title())
	out.Artist = strings.TrimSpace(m.Artist())
	out.Album = strings.TrimSpace(m.Album())
	out.Year = m.Year()
	if n, _ := m.Track(); n > 0 {
		out.TrackNo = n
	}
	out.Genres = splitGenres(m.Genre())
	out.Lyrics = cleanLyrics(m.Lyrics())
	// Embedded cover art (APIC) is imported so a well-tagged file keeps its art
	// instead of landing with a blank placeholder. Missing/blank pictures just
	// leave the fields empty — non-fatal, like duration.
	if pic := m.Picture(); pic != nil && len(pic.Data) > 0 {
		out.CoverBytes = pic.Data
		out.CoverMIME = pic.MIMEType
	}

	if _, err := r.Seek(0, io.SeekStart); err == nil {
		var sampleRate int
		out.DurationMS, sampleRate = decodeDuration(r)
		// Needs the decoded duration and a second pass over the file, so it runs
		// after the decode rather than inside it.
		out.Audio = readAudio(r, sampleRate, out.DurationMS)
	}
	return out, nil
}

var (
	bracketTag = regexp.MustCompile(`\[[^\]]*\]`)
	blankRuns  = regexp.MustCompile(`\n{3,}`)
)

// cleanLyrics strips Suno's bracketed directives ([Verse], [Chorus], [Guitar solo], …)
// and tidies the leftover whitespace, leaving only sung words. Parentheses are left
// intact — "(ooh)"/"(yeah)" ad-libs are usually actually sung. Keep in sync with the
// client-side cleanLyrics in ui/src/TagEditor.tsx.
func cleanLyrics(s string) string {
	s = bracketTag.ReplaceAllString(s, "")
	lines := strings.Split(s, "\n")
	for i, ln := range lines {
		lines[i] = strings.TrimRight(ln, " \t")
	}
	s = strings.Join(lines, "\n")
	s = blankRuns.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func splitGenres(raw string) []string {
	var genres []string
	for _, g := range strings.Split(raw, genreDelimiter) {
		if g = strings.TrimSpace(g); g != "" {
			genres = append(genres, g)
		}
	}
	return genres
}

// decodeDuration decodes the MP3 stream to measure its true length, and returns
// the stream's sample rate alongside it — the decoder already knows it, and the
// Info tab wants it, so throwing it away just means opening the file twice. go-mp3
// emits 16-bit little-endian stereo PCM (4 bytes per sample frame), so the duration
// is Length()/4/SampleRate seconds. Note the stereo output is the DECODER's, not
// the source's — it says nothing about the file's channel count (see audio.go).
// Returns zeroes on any decode error.
func decodeDuration(r io.Reader) (durationMS int64, sampleRate int) {
	d, err := mp3.NewDecoder(r)
	if err != nil {
		return 0, 0
	}
	sr := int64(d.SampleRate())
	if sr <= 0 {
		return 0, 0
	}
	frames := d.Length() / 4
	return frames * 1000 / sr, int(sr)
}
