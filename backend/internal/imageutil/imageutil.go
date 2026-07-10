// Package imageutil validates and measures uploaded cover images.
package imageutil

import (
	"errors"
	"image"
	// Blank imports register the JPEG/PNG decoders with image.DecodeConfig.
	_ "image/jpeg"
	_ "image/png"
	"io"
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
