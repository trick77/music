package metadata

import (
	"io"
)

// Audio properties of an encoded MP3, for the tag editor's Info tab.
//
// Bitrate is derived rather than read from a frame header, and that is the whole
// trick here. A frame header's declared rate is exact for CBR and simply WRONG for
// VBR (it describes frame 1, not the file), so trusting it would need Xing/Info
// detection and frame counting — the fiddly, bug-prone path. Instead:
//
//	kbps = audio bytes * 8 / duration in ms
//
// which is an AVERAGE by construction, so it's correct for CBR and VBR alike, and
// needs no bitrate tables and no Xing handling. Two inputs make it exact:
//
//   - Audio bytes, not file bytes. ID3 tags — especially an embedded cover, which
//     this app imports — are not audio, and counting them inflates the rate. Only
//     the tag sizes are parsed, which is a 10-byte header, not a frame parser.
//   - go-mp3's decoded duration, not a container's rounded claim. Verified against
//     ffprobe on testdata/sample.mp3: 33017 audio bytes over the decoder's 2063ms
//     gives 128 kbps, matching ffprobe's stream bitrate exactly. (Its container
//     duration of "2.000000" would have yielded 132.)
//
// Channels is the one field with no cheaper source: go-mp3 always decodes to
// stereo, so it cannot report the source's layout. It comes from two bits of the
// first frame header — no tables consulted, just the mode field.
type Audio struct {
	SampleRate  int // Hz, from the decoder
	Channels    int // 1 mono, 2 otherwise (stereo / joint stereo / dual channel)
	BitrateKbps int // average over the file
}

const (
	id3v1Size    = 128 // fixed-size "TAG" block at EOF
	id3v2Header  = 10  // "ID3" + version(2) + flags(1) + synchsafe size(4)
	id3v2Footer  = 10  // present only when the footer flag is set
	frameHeadLen = 4
)

// id3v2Len reports the total size of a leading ID3v2 tag, or 0 when there is none.
// The size field is "synchsafe": 7 bits per byte, so a tag can never contain a
// byte sequence that looks like a frame sync.
func id3v2Len(head []byte) int64 {
	if len(head) < id3v2Header || string(head[:3]) != "ID3" {
		return 0
	}
	s := head[6:10]
	// Any high bit set means this isn't a valid synchsafe integer.
	if s[0]&0x80 != 0 || s[1]&0x80 != 0 || s[2]&0x80 != 0 || s[3]&0x80 != 0 {
		return 0
	}
	n := int64(s[0])<<21 | int64(s[1])<<14 | int64(s[2])<<7 | int64(s[3])
	total := int64(id3v2Header) + n
	if head[5]&0x10 != 0 { // footer present
		total += id3v2Footer
	}
	return total
}

// id3v1Len reports 128 when the file ends with an ID3v1 "TAG" block, else 0.
func id3v1Len(r io.ReadSeeker, size int64) int64 {
	if size < id3v1Size {
		return 0
	}
	if _, err := r.Seek(size-id3v1Size, io.SeekStart); err != nil {
		return 0
	}
	buf := make([]byte, 3)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0
	}
	if string(buf) != "TAG" {
		return 0
	}
	return id3v1Size
}

// channelsAt reads the first frame header at or after `off` and reports the source
// channel count. Scans for the 11-bit frame sync because encoders may leave padding
// between the tag and the first frame; a sync pattern alone is not proof, so the
// reserved version/layer/bitrate/samplerate encodings are rejected too. Returns 0
// when no plausible frame turns up.
func channelsAt(r io.ReadSeeker, off int64) int {
	if _, err := r.Seek(off, io.SeekStart); err != nil {
		return 0
	}
	// A frame header lands within a few bytes of the tag in practice; cap the scan
	// so a garbage file can't walk the whole thing.
	const scanLimit = 8192
	buf := make([]byte, scanLimit)
	n, _ := io.ReadFull(r, buf)
	if n < frameHeadLen {
		return 0
	}
	buf = buf[:n]
	for i := 0; i+frameHeadLen <= len(buf); i++ {
		if buf[i] != 0xFF || buf[i+1]&0xE0 != 0xE0 {
			continue // not a sync
		}
		b1, b2, b3 := buf[i+1], buf[i+2], buf[i+3]
		if (b1>>3)&0x03 == 0x01 { // MPEG version 01 is reserved
			continue
		}
		if (b1>>1)&0x03 == 0x00 { // layer 00 is reserved
			continue
		}
		if br := (b2 >> 4) & 0x0F; br == 0x00 || br == 0x0F { // "free" / "bad"
			continue
		}
		if (b2>>2)&0x03 == 0x03 { // sample-rate index 11 is reserved
			continue
		}
		// Channel mode: 00 stereo, 01 joint stereo, 10 dual channel, 11 mono.
		if (b3>>6)&0x03 == 0x03 {
			return 1
		}
		return 2
	}
	return 0
}

// readAudio measures the stream's audio properties. durationMS comes from the
// caller because the decode has already happened; every field degrades to 0 rather
// than failing the import, matching duration's contract.
func readAudio(r io.ReadSeeker, sampleRate int, durationMS int64) Audio {
	out := Audio{SampleRate: sampleRate}

	size, err := r.Seek(0, io.SeekEnd)
	if err != nil || size <= 0 {
		return out
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return out
	}
	head := make([]byte, id3v2Header)
	if _, err := io.ReadFull(r, head); err != nil {
		return out
	}
	v2 := id3v2Len(head)
	audioBytes := size - v2 - id3v1Len(r, size)
	if audioBytes <= 0 {
		return out
	}

	out.Channels = channelsAt(r, v2)
	// bytes*8 per millisecond IS kilobits per second — no unit fudging needed.
	if durationMS > 0 {
		out.BitrateKbps = int(audioBytes * 8 / durationMS)
	}
	return out
}
