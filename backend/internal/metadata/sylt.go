package metadata

import (
	"bytes"
	"encoding/binary"
	"io"
	"unicode/utf16"

	id3v2 "github.com/bogem/id3v2/v2"
)

// SyncedWord is one timed lyric fragment for a SYLT frame. Text carries a leading
// "\n" when it starts a new lyric line (the ID3 convention for line breaks).
type SyncedWord struct {
	Text   string
	TimeMs uint32
}

// syncedLyricsFrame implements id3v2.Framer for the SYLT (synchronised lyrics)
// frame, which bogem/id3v2 v2.1.4 does not provide. Encoding is UTF-16 with a BOM
// (encoding byte 0x01, two-byte terminators) so arbitrary lyrics survive without
// requiring a v2.4 tag. Timestamps are absolute milliseconds (format 0x02),
// content type "lyrics" (0x01). Size() and WriteTo() both build from encodeUTF16,
// so the declared size can never drift from the emitted bytes.
type syncedLyricsFrame struct {
	language string
	words    []SyncedWord
}

// NewSyncedLyricsFrame returns a SYLT frame; add it via tag.AddFrame("SYLT", f).
func NewSyncedLyricsFrame(language string, words []SyncedWord) id3v2.Framer {
	if language == "" {
		language = "eng"
	}
	return syncedLyricsFrame{language: language, words: words}
}

// encodeUTF16 returns s as UTF-16LE with a leading BOM, followed by the two-byte
// UTF-16 terminator. Used for both the descriptor and every sync-text fragment.
func encodeUTF16(s string) []byte {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 0, 2+len(units)*2+2)
	b = append(b, 0xFF, 0xFE) // BOM (little-endian)
	for _, u := range units {
		b = append(b, byte(u), byte(u>>8))
	}
	b = append(b, 0x00, 0x00) // UTF-16 terminator
	return b
}

// header builds the fixed prefix: encoding(1) + language(3) + timeFormat(1) +
// contentType(1) + descriptor(text+term).
func (f syncedLyricsFrame) header() []byte {
	h := []byte{0x01}
	h = append(h, []byte(f.language)...)
	h = append(h, 0x02, 0x01) // ms timestamps, content type = lyrics
	h = append(h, encodeUTF16("")...)
	return h
}

func (f syncedLyricsFrame) Size() int {
	n := len(f.header())
	for _, w := range f.words {
		n += len(encodeUTF16(w.Text)) + 4 // text+term + uint32 timestamp
	}
	return n
}

// UniqueIdentifier keys the frame; one SYLT per (language, descriptor) is used and
// the descriptor is empty, so language alone is unique.
func (f syncedLyricsFrame) UniqueIdentifier() string { return f.language }

func (f syncedLyricsFrame) WriteTo(w io.Writer) (int64, error) {
	if len(f.language) != 3 {
		return 0, id3v2.ErrInvalidLanguageLength
	}
	var buf bytes.Buffer
	buf.Write(f.header())
	var ts [4]byte
	for _, wd := range f.words {
		buf.Write(encodeUTF16(wd.Text))
		binary.BigEndian.PutUint32(ts[:], wd.TimeMs)
		buf.Write(ts[:])
	}
	n, err := w.Write(buf.Bytes())
	return int64(n), err
}
