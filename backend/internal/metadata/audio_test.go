package metadata

import (
	"os"
	"testing"
)

// Ground truth comes from ffprobe, not from this package — a parser graded by its
// own output proves nothing:
//
//	ffprobe -v error -show_entries stream=sample_rate,channels,bit_rate <file>
//
// sample.mp3  44100 Hz  2ch  128000 bps  (CBR)
// mono96.mp3  44100 Hz  1ch   96000 bps  (CBR, mono — the channel branch)
// vbr.mp3     44100 Hz  2ch   34329 bps  (VBR — where first-frame bitrate lies)
func TestParse_AudioInfo(t *testing.T) {
	cases := []struct {
		file        string
		sampleRate  int
		channels    int
		bitrateKbps int
	}{
		{"testdata/sample.mp3", 44100, 2, 128},
		{"testdata/mono96.mp3", 44100, 1, 96},
		{"testdata/vbr.mp3", 44100, 2, 34},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			f, err := os.Open(c.file)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			defer f.Close()
			got, err := Parse(f)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if got.SampleRate != c.sampleRate {
				t.Errorf("SampleRate = %d, want %d", got.SampleRate, c.sampleRate)
			}
			if got.Channels != c.channels {
				t.Errorf("Channels = %d, want %d", got.Channels, c.channels)
			}
			// Bitrate is an average over the file, so it is meaningful for VBR too —
			// unlike a first frame's declared rate. Allow 1 kbps for integer rounding.
			if d := got.BitrateKbps - c.bitrateKbps; d < -1 || d > 1 {
				t.Errorf("BitrateKbps = %d, want %d (±1)", got.BitrateKbps, c.bitrateKbps)
			}
		})
	}
}
