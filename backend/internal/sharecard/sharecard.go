// Package sharecard renders the square social preview image used as og:image for
// a shared song or playlist link. Square is Apple's safe format — iOS 17+ crops
// link images toward a square, so a square image survives every iMessage context
// without clipping, and the same image renders identically in WhatsApp, Slack
// and Twitter.
//
// When the item has cover art, the image IS the cover, full bleed and nothing
// else. It used to be a composed card: the cover inset at 620px inside a 1200px
// canvas (27% of the area) with the title and artist drawn beneath it. Every
// client scales that whole canvas down to a card or a thumbnail, so the art
// arrived tiny and adrift in padding — and the baked-in text was drawn a second
// time by the client itself, right next to the image, from og:title and
// og:description. Full bleed spends the entire frame on the one thing the client
// cannot supply, which is what keeps a cover legible at WhatsApp thumbnail size.
//
// The composed text layout remains for items with no cover, where the title is
// the only content there is.
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

// Size is the pixel width and height of the rendered square preview image.
// Exported so the Open Graph layer advertises og:image:width/height that match
// what Render actually produces, rather than repeating the number.
//
// 640, not the old 1200: every client renders this into a card or a thumbnail a
// few hundred pixels wide, so the extra pixels bought no visible detail. Now
// that the frame is all cover art rather than mostly flat background they cost
// real bytes — measured on a real cover, 800@q88 encodes to 112KB against
// 640@q85's 70KB, itself down from the old card's 117KB. 640 is also what
// Spotify ships as its og:image.
const Size = 640

const (
	canvas = Size
	// The text metrics below apply only to the no-cover fallback. Scaled from
	// the 1200px canvas they were designed on, i.e. by 640/1200.
	margin     = 43
	titlePx    = 36
	subtitlePx = 24
	titleLead  = 44 // line height for wrapped title lines
	jpegQ      = 85
)

var (
	colBG  = color.RGBA{0x1f, 0x1f, 0x1e, 0xff} // --color-bg
	colInk = color.RGBA{0xfa, 0xf9, 0xf5, 0xff} // --color-ink
	// Deliberately lighter than --color-muted (#9c9a92). That token is tuned for
	// UI text viewed at full size; on a preview image the client scales the whole
	// frame down to a card or thumbnail, and the subtitle went illegible. This
	// sits between --color-muted and --color-ink to survive that downscale.
	colSubtle = color.RGBA{0xc9, 0xc6, 0xbd, 0xff}

	titleFace = mustFace(gobold.TTF, titlePx)
	subFace   = mustFace(goregular.TTF, subtitlePx)
)

func mustFace(ttf []byte, px float64) font.Face {
	f, err := opentype.Parse(ttf)
	if err != nil {
		panic(err) // bundled font bytes are constant — a parse failure is a build bug
	}
	// DPI 72 makes 1 point == 1 pixel, so px is the on-screen size.
	//
	// HintingNone, not HintingFull: full hinting snaps stems to the pixel grid,
	// which is what you want for small UI text but distorts glyph shapes at
	// display sizes and reads as jagged edges. These glyphs are 30-46px and are
	// then resampled again by the client, so unhinted antialiased outlines are
	// the smoother choice.
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: px, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		panic(err)
	}
	return face
}

// Render returns the JPEG bytes of the preview image. With a cover, that is the
// cover itself, center-cropped square and scaled to fill the frame. cover may be
// nil (no art), in which case the title and artist are drawn centered on the app
// surface instead — the only case where this package draws text at all.
func Render(cover image.Image, title, subtitle string) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, canvas, canvas))

	if cover != nil {
		// Src, not Over: the cover is opaque and covers every pixel, so there is
		// nothing to blend against and no need to paint the background first.
		xdraw.CatmullRom.Scale(img, img.Bounds(), cover, squareCrop(cover.Bounds()), xdraw.Src, nil)
		return encode(img)
	}

	draw.Draw(img, img.Bounds(), image.NewUniform(colBG), image.Point{}, draw.Src)
	titleLines := wrap(titleFace, strings.TrimSpace(title), canvas-2*margin, 2)
	subLines := wrap(subFace, strings.TrimSpace(subtitle), canvas-2*margin, 1)

	const gapTitleSub = 20
	blockH := len(titleLines) * titleLead
	if len(subLines) > 0 {
		blockH += gapTitleSub + subtitlePx
	}
	y := (canvas - blockH) / 2

	for _, line := range titleLines {
		y += titlePx // advance to this line's baseline
		drawCentered(img, titleFace, colInk, line, y)
		y += titleLead - titlePx
	}
	if len(subLines) > 0 {
		y += gapTitleSub + subtitlePx - (titleLead - titlePx)
		drawCentered(img, subFace, colSubtle, subLines[0], y)
	}
	return encode(img)
}

func encode(img image.Image) ([]byte, error) {
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
