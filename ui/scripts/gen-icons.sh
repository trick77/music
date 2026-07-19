#!/usr/bin/env bash
# Regenerate all favicon / PWA / share-card assets from the master tile SVG.
#
# The master (assets/icons/tile.svg) is a rounded orange app-tile with the app's
# cream lucide "music" note — a bare outline note turns to mush at 16px in the
# macOS Safari tab, so the tile gives it a solid boundary and high contrast.
#
# The SVG is rasterized with headless Google Chrome (crisp edges with
# transparency); ImageMagick only does raster resize/composite/.ico assembly,
# which it handles well. Do NOT let ImageMagick rasterize the SVG directly — its
# SVG renderer produces soft, distorted output.
#
#   ui/scripts/gen-icons.sh
#
# Re-run whenever the tile or brand color changes, then rebuild the UI so the new
# bytes land in backend/web/dist.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # ui/
ICONS="$DIR/assets/icons"
SRC="$ICONS/tile.svg"
OUT="$DIR/public"
DARK='#1f1f1e'        # app surface, for the share-card background (index.css --color-bg)
ORANGE='#d97757'      # app accent / tile background (index.css --color-accent)
INK='#faf9f5'         # app ink, for the wordmark (index.css --color-ink)

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONT="/System/Library/Fonts/SFNS.ttf"       # app's system-ui fallback, for the card wordmark
[ -f "$FONT" ] || FONT="/System/Library/Fonts/Helvetica.ttc"

command -v magick >/dev/null || { echo "magick (ImageMagick) not found" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Render the master tile to a large transparent PNG via headless Chrome.
# `--headless=new` writes the screenshot but does not reliably exit, so run it in
# the background, wait for the file, then kill it — never block on Chrome exiting.
cat > "$TMP/render.html" <<EOF
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}img{width:100vw;height:100vh}</style>
<img src="file://$SRC">
EOF
MASTER="$TMP/tile.png"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --no-first-run --user-data-dir="$TMP/chrome" --default-background-color=00000000 \
  --screenshot="$MASTER" --window-size=1024,1024 "file://$TMP/render.html" >/dev/null 2>&1 &
CPID=$!
for _ in $(seq 1 80); do [ -s "$MASTER" ] && break; sleep 0.25; done
sleep 0.4  # let the screenshot finish writing
kill "$CPID" 2>/dev/null || true; wait "$CPID" 2>/dev/null || true
[ -s "$MASTER" ] || { echo "Chrome render failed" >&2; exit 1; }

# fit resizes the master tile to $1 px at $2, keeping the transparent rounded corners.
fit() { magick "$MASTER" -filter Lanczos -resize "${1}x${1}" "$2"; }
# fit_opaque flattens the tile onto an opaque orange square ($1 px) at $2 — for icons
# the OS masks/rounds itself (apple-touch, maskable), so corners must be filled.
fit_opaque() { magick "$MASTER" -filter Lanczos -resize "${1}x${1}" -background "$ORANGE" -flatten "$2"; }

# --- favicon.svg: the tile master, served directly as the modern tab icon ---
cp "$SRC" "$OUT/favicon.svg"

# --- favicon.ico: 16/32/48 rounded tiles (transparent corners) ---
for s in 16 32 48; do fit "$s" "$TMP/fav_$s.png"; done
magick "$TMP/fav_16.png" "$TMP/fav_32.png" "$TMP/fav_48.png" "$OUT/favicon.ico"

# --- apple-touch-icon: full-bleed orange square (iOS applies its own rounded mask) ---
fit_opaque 180 "$OUT/apple-touch-icon.png"

# --- PWA "any" icons: rounded tiles, transparent corners ---
fit 192 "$OUT/icon-192.png"
fit 512 "$OUT/icon-512.png"

# --- PWA maskable: full-bleed orange square, note well inside the central safe zone ---
fit_opaque 512 "$OUT/icon-maskable-512.png"

# --- Default share card (WhatsApp/iMessage): tile + "Music" on dark, opaque ---
magick "$MASTER" -filter Lanczos -resize 240x240 "$TMP/tile_card.png"
magick -size 1200x630 xc:"$DARK" \
  \( "$TMP/tile_card.png" \) -gravity center -geometry +0-70 -composite \
  -font "$FONT" -pointsize 132 -fill "$INK" -gravity center -annotate +0+120 'Music' \
  "$OUT/og-card.png"

echo "Wrote: favicon.svg favicon.ico apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png og-card.png -> $OUT"
