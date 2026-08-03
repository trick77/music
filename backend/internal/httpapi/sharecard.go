package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register decoders for cover art
	_ "image/jpeg" // (covers are JPEG or PNG; WebP added below)
	_ "image/png"
	"io"
	"net/http"
	"time"

	"github.com/trick77/music/internal/sharecard"
	_ "golang.org/x/image/webp" // register WebP decoder (decode-only)
)

// getSongCard renders the 1200x1200 social preview card (cover + title + artist)
// used as a song link's og:image. Public and not auth-aware, so it mirrors
// songMeta's gate: unpublished/unknown songs 404 rather than leak their metadata.
func (h *songHandlers) getSongCard(w http.ResponseWriter, r *http.Request) {
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	if song == nil || !song.Published {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	h.writeCard(w, r, h.loadCover(r.Context(), song.CoverArtID), song.Title, song.ArtistName)
}

// getPlaylistCard renders the share card for a playlist link, mirroring
// playlistMeta: subtitle is the published-track count, and the cover falls back
// to the first published track's art when the playlist has none of its own.
func (h *songHandlers) getPlaylistCard(w http.ResponseWriter, r *http.Request) {
	pl, err := h.repo.GetPlaylist(r.Context(), r.PathValue("id"), false)
	if err != nil {
		serverError(w, "get playlist", err)
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	n := len(pl.Songs)
	noun := "songs"
	if n == 1 {
		noun = "song"
	}
	coverID := pl.CoverArtID
	if coverID == "" && n > 0 {
		coverID = pl.Songs[0].CoverArtID
	}
	h.writeCard(w, r, h.loadCover(r.Context(), coverID), pl.Name, fmt.Sprintf("Playlist · %d %s", n, noun))
}

// writeCard renders and serves a card as JPEG. Cacheable: link unfurlers refetch,
// and the content-free 404/500 paths are handled by the callers.
//
// Served via ServeContent rather than a plain Write so the response carries an
// explicit Content-Length and Accept-Ranges. A card is ~120KB, which overflows
// net/http's sniff buffer, so a bare Write falls back to chunked encoding with
// no length — and Slack's image proxy drops an og:image it can't size, which
// unfurls the link with title and artist but no cover art.
func (h *songHandlers) writeCard(w http.ResponseWriter, r *http.Request, cover image.Image, title, subtitle string) {
	jpg, err := sharecard.Render(cover, title, subtitle)
	if err != nil {
		serverError(w, "render share card", err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	// Zero modtime: cards are derived, so there is no meaningful Last-Modified
	// to hand out and ServeContent skips the conditional-request handling.
	http.ServeContent(w, r, "card.jpg", time.Time{}, bytes.NewReader(jpg))
}

// loadCover decodes a cover into an image, or returns nil (no art / unreadable /
// undecodable) so the card falls back to a text-only layout instead of failing.
func (h *songHandlers) loadCover(ctx context.Context, coverID string) image.Image {
	if coverID == "" {
		return nil
	}
	relPath, err := h.repo.GetCoverPath(ctx, coverID)
	if errors.Is(err, sql.ErrNoRows) || err != nil || relPath == "" {
		return nil
	}
	f, err := h.media.Open(relPath)
	if err != nil {
		return nil
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	return img
}
