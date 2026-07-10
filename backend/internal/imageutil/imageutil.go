// Package imageutil validates and measures uploaded cover images.
package imageutil

import (
	"errors"
	"fmt"
	"image"
	// Blank imports register the JPEG/PNG decoders with image.DecodeConfig.
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
)

// ErrUnsupported is returned for inputs that are not a supported image format.
var ErrUnsupported = errors.New("imageutil: unsupported image format")

// Probe reads only the image header and returns its dimensions and a normalized
// extension ("jpg" or "png"). Non-image or unsupported input yields ErrUnsupported.
func Probe(r io.Reader) (width, height int, ext string, err error) {
	cfg, format, err := image.DecodeConfig(r)
	if err != nil {
		return 0, 0, "", ErrUnsupported
	}
	switch format {
	case "jpeg":
		ext = "jpg"
	case "png":
		ext = "png"
	default:
		return 0, 0, "", ErrUnsupported
	}
	return cfg.Width, cfg.Height, ext, nil
}

// AverageColor decodes an image and returns the mean RGB as a #rrggbb hex string.
// It samples on a stride so multi-megapixel inputs stay cheap. Non-image input
// yields ErrUnsupported.
func AverageColor(r io.Reader) (string, error) {
	img, _, err := image.Decode(r)
	if err != nil {
		return "", ErrUnsupported
	}
	b := img.Bounds()
	if b.Empty() {
		return "", ErrUnsupported
	}
	stride := 1
	if n := b.Dx() * b.Dy(); n > 65536 {
		stride = int(math.Sqrt(float64(n) / 65536.0))
		if stride < 1 {
			stride = 1
		}
	}
	var sumR, sumG, sumB, count uint64
	for y := b.Min.Y; y < b.Max.Y; y += stride {
		for x := b.Min.X; x < b.Max.X; x += stride {
			r16, g16, b16, _ := img.At(x, y).RGBA() // 16-bit per channel
			sumR += uint64(r16 >> 8)
			sumG += uint64(g16 >> 8)
			sumB += uint64(b16 >> 8)
			count++
		}
	}
	if count == 0 {
		return "", ErrUnsupported
	}
	return fmt.Sprintf("#%02x%02x%02x", sumR/count, sumG/count, sumB/count), nil
}
