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

func TestRender_isAlwaysSquareAtSize(t *testing.T) {
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

func TestRender_coverFillsTheWholeFrame(t *testing.T) {
	// The whole point of the image is the art: a cover must reach the corners,
	// not sit inset on the app surface. It used to occupy 620 of 1200 px (27% of
	// the area), which every client then scaled down to a card or thumbnail, so
	// the art arrived tiny and surrounded by padding.
	const w, h = 300, 500 // non-square, so this also exercises the center-crop
	cover := image.NewRGBA(image.Rect(0, 0, w, h))
	orange := color.RGBA{0xd0, 0x60, 0x20, 0xff}
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			cover.Set(x, y, orange)
		}
	}

	out, err := Render(cover, "Night Drive", "The Band")
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("output is not a decodable JPEG: %v", err)
	}

	// Sample the four corners. On the old inset layout these were background.
	for _, pt := range []image.Point{
		{X: 2, Y: 2},
		{X: Size - 3, Y: 2},
		{X: 2, Y: Size - 3},
		{X: Size - 3, Y: Size - 3},
	} {
		r, g, b, _ := img.At(pt.X, pt.Y).RGBA()
		br, bg, bb, _ := colBG.RGBA()
		if near(r, br) && near(g, bg) && near(b, bb) {
			t.Fatalf("corner %v is the background colour; cover is not full bleed", pt)
		}
		if !near(r, uint32(orange.R)<<8) || !near(g, uint32(orange.G)<<8) || !near(b, uint32(orange.B)<<8) {
			t.Fatalf("corner %v = rgb(%d,%d,%d), want the cover colour", pt, r>>8, g>>8, b>>8)
		}
	}
}

// near allows for JPEG's lossy round-trip when comparing 16-bit channels.
func near(a, b uint32) bool {
	d := int(a) - int(b)
	if d < 0 {
		d = -d
	}
	return d < 0x1800
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
