#!/usr/bin/env bash
# Regenerate every favicon / PWA / share-card raster from the three SVG sources
# in assets/icons/. Run it by hand after editing any of them and commit what it
# writes.
#
#   ui/scripts/gen-icons.sh
#
# The outputs are COMMITTED rather than generated during the build, so neither
# `npm run build` nor CI needs an image toolchain. That is the whole reason this
# is not a package.json script.
#
# librsvg does the rasterising, not ImageMagick's own SVG support: IM's internal
# MSVG delegate renders stroked paths soft and distorted. ImageMagick is used
# only on rasters it already holds — the share card, and re-reading the results
# to assert their grounds. This replaces an older headless-Chrome screenshot
# dance (Chrome's `--headless=new` writes the file but does not reliably exit, so
# it had to be backgrounded, polled for and killed); rsvg-convert is one
# synchronous call, and works off macOS.
#
# There is no favicon.ico here, and no /favicon.svg either: the tab icon is
# /icon.svg, which is the name peeq and loom already use and the one that matches
# the icon-*.png rasters beside it. Music declares an SVG icon in <head>, and the
# clients that go looking for a bare /favicon.ico are RSS readers, Windows
# bookmark thumbnails and old IE — none of which this targets. backend/web
# answers that path with a 404 instead.
#
# Re-run whenever a source or a brand colour changes, then rebuild the UI so the
# new bytes land in backend/web/dist.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # ui/
SRC="$DIR/assets/icons"
OUT="$DIR/public"
MASTER="$SRC/tile.svg"   # the shape; renders the PWA rasters, never ships itself
FAVICON="$SRC/icon-favicon.svg" # the master with a filled frame; ships as-is
DARK='#1f1f1e'           # app surface, the tile ground and the card background (index.css --color-bg)
TAB='#33322f'            # the tab icon's ground — lighter than DARK, see icon-favicon.svg
INK='#faf9f5'            # app ink, for the card wordmark (index.css --color-ink)

FONT="/System/Library/Fonts/SFNS.ttf" # app's system-ui fallback, for the card wordmark
[ -f "$FONT" ] || FONT="/System/Library/Fonts/Helvetica.ttc"

for tool in rsvg-convert magick; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "gen-icons: $tool not found — brew install librsvg imagemagick" >&2
		exit 1
	fi
done
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- icon.svg: served directly as the modern tab icon ------------------------
# Its own source, not the master: Safari on the desktop composites the tab icon
# onto white, so this one carries a ground where the master does not.
cp "$FAVICON" "$OUT/icon.svg"

# --- from the master ---------------------------------------------------------
# -b none keeps the renderer from inventing a ground the master does not have.
# These stay TRANSPARENT: a launcher composites them itself, and both glyphs are
# outlines enclosing no area, so there is no interior for its colour to fill and
# read as a background.
rsvg-convert -b none -w 192 -h 192 "$MASTER" -o "$OUT/icon-192.png"
rsvg-convert -b none -w 512 -h 512 "$MASTER" -o "$OUT/icon-512.png"

# --- from the tiled sources --------------------------------------------------
# These two carry a smaller glyph and square corners because the OS crops them:
# iOS with its superellipse mask, Android with whatever the launcher picks. They
# also run edge to edge, because iOS flattens alpha onto black and Android fills
# it with the launcher's own colour — neither is ours to choose.
rsvg-convert -w 180 -h 180 "$SRC/tile-touch.svg" -o "$OUT/apple-touch-icon.png"
rsvg-convert -w 512 -h 512 "$SRC/tile-maskable.svg" -o "$OUT/icon-maskable-512.png"

# --- default share card (WhatsApp/iMessage): mark + "Music" on dark ----------
# Rendered from tile-touch.svg, not the master: the card's background is the same
# #1f1f1e as the icon ground, so a 96% mark would read as a note crowding the
# card rather than as a mark set in it. The 60% source gives it the inset for
# free, and its edges are invisible against a matching background anyway.
rsvg-convert -w 240 -h 240 "$SRC/tile-touch.svg" -o "$TMP/card_mark.png"
magick -size 1200x630 xc:"$DARK" \
	\( "$TMP/card_mark.png" \) -gravity center -geometry +0-70 -composite \
	-font "$FONT" -pointsize 132 -fill "$INK" -gravity center -annotate +0+120 'Music' \
	"$OUT/og-card.png"

# --- verify the grounds survived --------------------------------------------
# Rendering can succeed and still produce the wrong thing — most plausibly a
# source that lost its background rect, which yields a touch icon iOS flattens
# onto black. That fails silently in a viewer and only shows up on a real
# device, so assert every ground here instead.
#
# The split is the point, so every direction is checked. The master's rasters
# MUST stay transparent: a launcher composites them itself. The two OS tiles MUST
# stay opaque: iOS flattens alpha onto black and Android fills it with the
# launcher's own colour, so a transparent one ships as a black square on an
# iPhone. And icon.svg must be BOTH — a filled frame inside transparent
# corners. None of these is a formality; do not "fix" a failure by relaxing the
# check.
fail=0
check_alpha() { # <file> <expected true|false>
	local got
	# ImageMagick 7 prints "True"/"False"; 6 printed "true"/"false". Fold the
	# case so this script is not pinned to one major version.
	got="$(magick identify -format '%[opaque]' "$1" | tr '[:upper:]' '[:lower:]')"
	if [[ "$got" != "$2" ]]; then
		echo "gen-icons: $(basename "$1") is opaque=$got, expected $2" >&2
		fail=1
	fi
}
check_alpha "$OUT/icon-192.png" false
check_alpha "$OUT/icon-512.png" false
check_alpha "$OUT/apple-touch-icon.png" true
check_alpha "$OUT/icon-maskable-512.png" true
check_alpha "$OUT/og-card.png" true

# icon.svg ships as SVG, so there is no raster to read — render one here just
# to assert it. Two samples, because it has to be a chip and not a tile: the
# canvas corner transparent, and a point inside the frame but clear of the
# headphones (they start around y=170 at this size) filled with $TAB. Losing the
# fill is the regression that put this check here, and it is invisible until
# someone opens a tab in Safari.
rsvg-convert -b none -w 512 -h 512 "$OUT/icon.svg" -o "$TMP/icon-favicon.png"
# -alpha on before both reads. Without it an image that happens to be fully
# opaque carries no alpha channel, and then %[hex:...] returns six digits
# instead of eight and %[fx:...a] does not report 1 — the comparisons below
# would be measuring ImageMagick's channel bookkeeping rather than the icon.
fav_corner="$(magick "$TMP/icon-favicon.png" -alpha on -format '%[fx:p{0,0}.a]' info:)"
fav_ground="$(magick "$TMP/icon-favicon.png" -alpha on -format '%[hex:p{256,96}]' info: | tr '[:upper:]' '[:lower:]')"
if [[ "$fav_corner" != "0" ]]; then
	echo "gen-icons: icon.svg's canvas corner has alpha $fav_corner, expected 0" >&2
	fail=1
fi
if [[ "$fav_ground" != "${TAB#\#}ff" ]]; then
	echo "gen-icons: icon.svg's frame is #$fav_ground, expected ${TAB}ff" >&2
	fail=1
fi

# The maskable icon has one more thing to prove: Android crops it to the
# launcher's own shape, and only the middle 80% of the square — a circle of
# radius 204.8 at 512px — is guaranteed to survive. Assert the glyph clears that
# circle rather than trusting the transform in tile-maskable.svg to still match
# its comment.
#
# Painting the safe circle over in the ground colour leaves nothing but ground
# IF the mark is fully inside it, so the whole image collapses to one flat
# colour and its standard deviation is exactly 0. Any mark left outside shows up
# as spread. Calibrated by rendering the glyph at a sweep of coverages: 0 up to
# and including 58.5%, and 0.0012 at 59% — which is where the geometry says it
# crosses (the flag's top-right corner is 13.978 units out in the 24-space, and
# 25.6/13.978 caps the scale at 1.831, i.e. 58.7% coverage). The threshold sits
# well under that first real reading.
CIRCLE_STDDEV="$(magick "$OUT/icon-maskable-512.png" -alpha off \
	-fill "$DARK" -draw 'circle 256,256 256,51.2' \
	-format '%[fx:standard_deviation]' info:)"
if (($(echo "$CIRCLE_STDDEV > 0.0005" | bc -l))); then
	echo "gen-icons: icon-maskable-512.png has mark outside the 80% safe circle (stddev $CIRCLE_STDDEV)" >&2
	fail=1
fi

[[ "$fail" == 0 ]] || exit 1
echo "gen-icons: wrote icon.svg apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png og-card.png -> $OUT"
