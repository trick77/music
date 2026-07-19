package sharecard

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"strings"
	"testing"
)

func decode(t *testing.T, b []byte) image.Config {
	t.Helper()
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("output is not a decodable JPEG: %v", err)
	}
	return cfg
}

func TestRender_isAlways1200Square(t *testing.T) {
	cover := image.NewRGBA(image.Rect(0, 0, 300, 500)) // non-square, exercises center-crop
	draw := color.RGBA{0x80, 0x40, 0x20, 0xff}
	for x := 0; x < 300; x++ {
		for y := 0; y < 500; y++ {
			cover.Set(x, y, draw)
		}
	}
	cases := []struct {
		name            string
		cover           image.Image
		title, subtitle string
	}{
		{"with cover", cover, "Night Drive", "The Band"},
		{"no cover", nil, "Untitled", ""},
		{"very long title wraps and truncates", cover,
			strings.Repeat("Supercalifragilistic ", 12), "An Artist With A Rather Long Name Indeed"},
		{"empty strings", nil, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := Render(tc.cover, tc.title, tc.subtitle)
			if err != nil {
				t.Fatalf("Render: %v", err)
			}
			cfg := decode(t, out)
			if cfg.Width != canvas || cfg.Height != canvas {
				t.Fatalf("dims = %dx%d, want %dx%d", cfg.Width, cfg.Height, canvas, canvas)
			}
		})
	}
}

func TestWrap_respectsMaxLines(t *testing.T) {
	lines := wrap(titleFace, strings.Repeat("word ", 40), canvas-160, 2)
	if len(lines) > 2 {
		t.Fatalf("got %d lines, want <= 2", len(lines))
	}
	if len(lines) == 0 {
		t.Fatal("expected at least one line")
	}
	// Overflow is signalled with an ellipsis on the last line.
	if !strings.HasSuffix(lines[len(lines)-1], "…") {
		t.Fatalf("truncated wrap should end with an ellipsis, got %q", lines[len(lines)-1])
	}
}
