#!/usr/bin/env bash
# Regenerate all favicon / PWA / share-card assets from the master note SVG.
#
# The SVG is rasterized with headless Google Chrome (crisp stroke rendering with
# transparency); ImageMagick only does raster resize/composite/.ico assembly,
# which it handles well. Do NOT let ImageMagick rasterize the SVG directly — its
# SVG renderer produces soft, distorted output for stroke-based icons.
#
#   ui/scripts/gen-icons.sh
#
# Re-run whenever the note or brand color changes, then rebuild the UI so the new
# bytes land in backend/web/dist.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ui/
ICONS="$DIR/assets/icons"
SRC="$ICONS/note.svg"
OUT="$DIR/public"
DARK='#1f1f1e'        # app surface, for opaque icons/card (index.css --color-bg)
INK='#faf9f5'         # app ink, for the wordmark (index.css --color-ink)

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONT="/System/Library/Fonts/SFNS.ttf"       # app's system-ui fallback, for the card wordmark
[ -f "$FONT" ] || FONT="/System/Library/Fonts/Helvetica.ttc"

command -v magick >/dev/null || { echo "magick (ImageMagick) not found" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Render the master note to a large transparent PNG via headless Chrome.
# `--headless=new` writes the screenshot but does not reliably exit, so run it in
# the background, wait for the file, then kill it — never block on Chrome exiting.
cat > "$TMP/render.html" <<EOF
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}img{width:100vw;height:100vh}</style>
<img src="file://$SRC">
EOF
MASTER="$TMP/note.png"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --no-first-run --user-data-dir="$TMP/chrome" --default-background-color=00000000 \
  --screenshot="$MASTER" --window-size=1024,1024 "file://$TMP/render.html" >/dev/null 2>&1 &
CPID=$!
for _ in $(seq 1 80); do [ -s "$MASTER" ] && break; sleep 0.25; done
sleep 0.4  # let the screenshot finish writing
kill "$CPID" 2>/dev/null || true; wait "$CPID" 2>/dev/null || true
[ -s "$MASTER" ] || { echo "Chrome render failed" >&2; exit 1; }

# note_on renders the note at $1 px onto a $2 canvas ($3 background: none|color),
# to $4. Downscaling the crisp master with Lanczos keeps small sizes clean.
note_on() {
  local inner=$1 size=$2 bg=$3 out=$4
  if [ "$bg" = none ]; then
    magick "$MASTER" -filter Lanczos -resize ${inner}x${inner} \
      -background none -gravity center -extent ${size}x${size} "$out"
  else
    magick "$MASTER" -filter Lanczos -resize ${inner}x${inner} \
      -background "$bg" -gravity center -extent ${size}x${size} -flatten "$out"
  fi
}

# --- favicon.svg: the master, served directly as the modern tab icon ---
cp "$SRC" "$OUT/favicon.svg"

# --- favicon.ico: 16/32/48, transparent, edge-to-edge for small-size legibility ---
for s in 16 32 48; do magick "$MASTER" -filter Lanczos -resize ${s}x${s} "$TMP/fav_$s.png"; done
magick "$TMP/fav_16.png" "$TMP/fav_32.png" "$TMP/fav_48.png" "$OUT/favicon.ico"

# --- apple-touch-icon: opaque (iOS composites transparency on black) ---
note_on 116 180 "$DARK" "$OUT/apple-touch-icon.png"

# --- PWA "any" icons: transparent, light padding ---
note_on 150 192 none "$OUT/icon-192.png"
note_on 400 512 none "$OUT/icon-512.png"

# --- PWA maskable: opaque, note well inside the central safe zone ---
note_on 300 512 "$DARK" "$OUT/icon-maskable-512.png"

# --- Default share card (WhatsApp/iMessage): note + "Music" on dark, opaque ---
magick "$MASTER" -filter Lanczos -resize 220x220 "$TMP/note_card.png"
magick -size 1200x630 xc:"$DARK" \
  \( "$TMP/note_card.png" \) -gravity center -geometry +0-70 -composite \
  -font "$FONT" -pointsize 132 -fill "$INK" -gravity center -annotate +0+120 'Music' \
  "$OUT/og-card.png"

echo "Wrote: favicon.svg favicon.ico apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png og-card.png -> $OUT"
