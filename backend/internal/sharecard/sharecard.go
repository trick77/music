// Package sharecard renders the 1200x1200 social preview card used as og:image
// for a shared song or playlist link (album cover + title + artist on the dark
// app surface). Square is Apple's safe format — iOS 17+ crops link images toward
// a square, so a 1200x1200 card survives every iMessage context without clipping,
// and the same card renders identically in WhatsApp, Slack, and Twitter.
package sharecard

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const (
	canvas     = 1200
	coverSize  = 620
	titlePx    = 68
	subtitlePx = 44
	titleLead  = 82 // line height for wrapped title lines
	jpegQ      = 88
)

var (
	colBG    = color.RGBA{0x1f, 0x1f, 0x1e, 0xff} // --color-bg
	colInk   = color.RGBA{0xfa, 0xf9, 0xf5, 0xff} // --color-ink
	colMuted = color.RGBA{0x9c, 0x9a, 0x92, 0xff} // --color-muted

	titleFace = mustFace(gobold.TTF, titlePx)
	subFace   = mustFace(goregular.TTF, subtitlePx)
)

func mustFace(ttf []byte, px float64) font.Face {
	f, err := opentype.Parse(ttf)
	if err != nil {
		panic(err) // bundled font bytes are constant — a parse failure is a build bug
	}
	// DPI 72 makes 1 point == 1 pixel, so px is the on-screen size.
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: px, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		panic(err)
	}
	return face
}

// Render composes the card and returns JPEG bytes. cover may be nil (no art),
// in which case the text block is centered on the empty canvas.
func Render(cover image.Image, title, subtitle string) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, canvas, canvas))
	draw.Draw(img, img.Bounds(), image.NewUniform(colBG), image.Point{}, draw.Src)

	titleLines := wrap(titleFace, strings.TrimSpace(title), canvas-2*80, 2)
	subLines := wrap(subFace, strings.TrimSpace(subtitle), canvas-2*80, 1)

	// Lay the cover + text out as one block, vertically centered.
	const gapCoverText = 74
	const gapTitleSub = 30
	blockH := len(titleLines) * titleLead
	if len(subLines) > 0 {
		blockH += gapTitleSub + subtitlePx
	}
	if cover != nil {
		blockH += coverSize + gapCoverText
	}
	y := (canvas - blockH) / 2

	if cover != nil {
		dst := image.Rect((canvas-coverSize)/2, y, (canvas+coverSize)/2, y+coverSize)
		xdraw.CatmullRom.Scale(img, dst, cover, squareCrop(cover.Bounds()), xdraw.Over, nil)
		y += coverSize + gapCoverText
	}

	for _, line := range titleLines {
		y += titlePx // advance to this line's baseline
		drawCentered(img, titleFace, colInk, line, y)
		y += titleLead - titlePx
	}
	if len(subLines) > 0 {
		y += gapTitleSub + subtitlePx - (titleLead - titlePx)
		drawCentered(img, subFace, colMuted, subLines[0], y)
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQ}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// squareCrop returns the largest centered square within b, so a non-square cover
// is center-cropped (never stretched) when scaled into the square slot.
func squareCrop(b image.Rectangle) image.Rectangle {
	if b.Dx() == b.Dy() {
		return b
	}
	side := b.Dx()
	if b.Dy() < side {
		side = b.Dy()
	}
	cx, cy := (b.Min.X+b.Max.X)/2, (b.Min.Y+b.Max.Y)/2
	return image.Rect(cx-side/2, cy-side/2, cx-side/2+side, cy-side/2+side)
}

func drawCentered(dst draw.Image, face font.Face, col color.Color, s string, baseline int) {
	w := font.MeasureString(face, s).Round()
	d := &font.Drawer{
		Dst:  dst,
		Src:  image.NewUniform(col),
		Face: face,
		Dot:  fixed.Point26_6{X: fixed.I((canvas - w) / 2), Y: fixed.I(baseline)},
	}
	d.DrawString(s)
}

// wrap greedily packs s into at most maxLines lines that each fit maxW pixels.
// If words remain after the last allowed line, that line is ellipsized to signal
// the truncation; a single word wider than maxW is hard-truncated with an ellipsis.
func wrap(face font.Face, s string, maxW, maxLines int) []string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return nil
	}
	fits := func(str string) bool { return font.MeasureString(face, str).Round() <= maxW }

	var lines []string
	i := 0
	for i < len(words) && len(lines) < maxLines {
		cur := words[i]
		i++
		for i < len(words) && fits(cur+" "+words[i]) {
			cur += " " + words[i]
			i++
		}
		if !fits(cur) { // a lone word too wide for the line
			cur = truncate(face, cur, maxW)
		}
		lines = append(lines, cur)
	}
	if i < len(words) && len(lines) > 0 { // ran out of lines with text remaining
		last := len(lines) - 1
		lines[last] = ellipsize(face, lines[last], maxW)
	}
	return lines
}

// truncate drops trailing runes until s plus an ellipsis fits maxW.
func truncate(face font.Face, s string, maxW int) string {
	if font.MeasureString(face, s).Round() <= maxW {
		return s
	}
	return ellipsize(face, s, maxW)
}

// ellipsize returns s shortened so that s+"…" fits maxW (used to mark truncation).
func ellipsize(face font.Face, s string, maxW int) string {
	r := []rune(s)
	for len(r) > 0 {
		cand := strings.TrimRight(string(r), " ") + "…"
		if font.MeasureString(face, cand).Round() <= maxW {
			return cand
		}
		r = r[:len(r)-1]
	}
	return "…"
}
