package imageutil

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

func TestProbe_jpeg(t *testing.T) {
	w, h, ext, err := Probe(bytes.NewReader(jpegBytes(t, 320, 200)))
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if w != 320 || h != 200 || ext != "jpg" {
		t.Fatalf("got %dx%d %q", w, h, ext)
	}
}

func TestProbe_png(t *testing.T) {
	_, _, ext, err := Probe(bytes.NewReader(pngBytes(t, 64, 64)))
	if err != nil || ext != "png" {
		t.Fatalf("png probe: ext=%q err=%v", ext, err)
	}
}

func TestProbe_rejectsNonImage(t *testing.T) {
	if _, _, _, err := Probe(strings.NewReader("not an image")); err == nil {
		t.Fatal("expected error for non-image")
	}
}

func TestAverageColor_meanHex(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	// Two black, two white pixels -> mean 127.5 -> 0x7f or 0x80 per channel.
	img.Set(0, 0, color.RGBA{0, 0, 0, 255})
	img.Set(1, 0, color.RGBA{0, 0, 0, 255})
	img.Set(0, 1, color.RGBA{255, 255, 255, 255})
	img.Set(1, 1, color.RGBA{255, 255, 255, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	hex, err := AverageColor(&buf)
	if err != nil {
		t.Fatalf("AverageColor: %v", err)
	}
	if hex != "#7f7f7f" && hex != "#808080" {
		t.Fatalf("AverageColor = %q, want mid-grey", hex)
	}
}

func TestAverageColor_rejectsNonImage(t *testing.T) {
	if _, err := AverageColor(strings.NewReader("not an image")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("err = %v, want ErrUnsupported", err)
	}
}
