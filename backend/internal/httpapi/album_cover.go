package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
)

// listAlbums returns the distinct artist+album pairings for the Studio album-cover
// picker. Authed-only (Studio surface).
func (h *songHandlers) listAlbums(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	albums, err := h.repo.ListAlbums(r.Context())
	if err != nil {
		serverError(w, "list albums", err)
		return
	}
	writeJSON(w, map[string]any{"albums": albums})
}

// albumRef identifies an album by its artist and (case-insensitive) title.
type albumRef struct {
	ArtistID string `json:"artistId"`
	Album    string `json:"album"`
}

// postAlbumSuggestPrompt returns an editable square-cover prompt for an album,
// authored by a one-shot LLM call seeded with the artist, album title, and
// genre(s). Mirrors postGenreSuggestPrompt. Auth-gated (403) and
// chat-config-gated (404).
func (h *songHandlers) postAlbumSuggestPrompt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.genrePrompter == nil {
		httpError(w, http.StatusNotFound, "prompt suggestions are not configured")
		return
	}
	var req albumRef
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	actx, err := h.repo.AlbumContext(r.Context(), req.ArtistID, req.Album)
	if err != nil {
		serverError(w, "album context", err)
		return
	}
	if !actx.Exists {
		httpError(w, http.StatusNotFound, "unknown album")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	prompt, err := h.genrePrompter.AlbumCoverPrompt(ctx, actx.ArtistName, strings.TrimSpace(req.Album), actx.Genres, actx.Lyrics)
	if err != nil {
		serverError(w, "suggest album prompt", err)
		return
	}
	writeJSON(w, map[string]string{"prompt": prompt})
}

// postAlbumCover applies a previously generated Studio cover-art image to an
// album: it copies the generated PNG into the deduped cover_art store and maps it
// to every song of the artist+album. Auth-gated + image-generation-config-gated.
func (h *songHandlers) postAlbumCover(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if !h.cfg.ImageGenEnabled() || h.imageGen == nil {
		httpError(w, http.StatusNotFound, "studio cover art is not configured")
		return
	}
	var req struct {
		ArtistID         string `json:"artistId"`
		Album            string `json:"album"`
		StudioCoverArtID string `json:"studioCoverArtId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.ArtistID) == "" || strings.TrimSpace(req.Album) == "" || strings.TrimSpace(req.StudioCoverArtID) == "" {
		httpError(w, http.StatusBadRequest, "artistId, album and studioCoverArtId are required")
		return
	}

	// The album must exist; otherwise SetAlbumCover would create a dangling mapping
	// no song references.
	actx, err := h.repo.AlbumContext(r.Context(), req.ArtistID, req.Album)
	if err != nil {
		serverError(w, "album context", err)
		return
	}
	if !actx.Exists {
		httpError(w, http.StatusNotFound, "unknown album")
		return
	}

	art, err := h.repo.GetStudioCoverArt(r.Context(), req.StudioCoverArtID)
	if err != nil {
		serverError(w, "get cover art", err)
		return
	}
	if art == nil || art.Status != "ready" || art.ImagePath == "" {
		httpError(w, http.StatusNotFound, "cover art not found")
		return
	}

	data, err := readMediaBytes(h.media, art.ImagePath)
	if err != nil {
		serverError(w, "read generated cover", err)
		return
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])

	width, height := art.Width, art.Height
	ext := "png"
	if pw, ph, pext, perr := imageutil.Probe(bytes.NewReader(data)); perr == nil {
		width, height, ext = pw, ph, pext
	}

	// Store the bytes under covers/<hash>.<ext> only if this content is new
	// (CreateCover dedupes by hash, but the file must exist for a fresh hash).
	relPath := "covers/" + hash + "." + ext
	if existingID, _, herr := h.repo.FindCoverByHash(r.Context(), hash); herr != nil {
		serverError(w, "cover lookup", herr)
		return
	} else if existingID == "" {
		if werr := writeBytes(h.media, relPath, data); werr != nil {
			serverError(w, "store cover", werr)
			return
		}
	}
	coverID, err := h.repo.CreateCover(r.Context(), library.CoverParams{
		ImagePath: relPath, Width: width, Height: height, ContentHash: hash,
	})
	if err != nil {
		serverError(w, "save cover", err)
		return
	}
	if err := h.repo.SetAlbumCover(r.Context(), req.ArtistID, req.Album, coverID); err != nil {
		serverError(w, "apply album cover", err)
		return
	}
	writeJSON(w, map[string]any{"coverArtId": coverID})
}

// readMediaBytes reads a stored media file fully into memory. Cover images are
// small, so buffering is fine.
func readMediaBytes(store *media.Store, relPath string) ([]byte, error) {
	f, err := store.Open(relPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
