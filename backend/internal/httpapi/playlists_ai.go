package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

// postSuggestPrompt returns an editable square-cover prompt grounded in the
// playlist's songs (name + distinct genres). Auth-gated (403) and
// chat-config-gated (404). 400 if the playlist is empty (nothing to ground on).
func (h *playlistHandlers) postSuggestPrompt(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if h.genrePrompter == nil {
		httpError(w, http.StatusNotFound, "prompt suggestions are not configured")
		return
	}
	id := r.PathValue("id")
	name, songs, err := h.repo.PlaylistContext(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpError(w, http.StatusNotFound, "not found")
			return
		}
		serverError(w, "playlist context", err)
		return
	}
	if len(songs) == 0 {
		httpError(w, http.StatusBadRequest, "playlist has no songs")
		return
	}
	genres := distinctGenres(songs)
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	prompt, err := h.genrePrompter.AlbumCoverPrompt(ctx, name, name, genres, nil)
	if err != nil {
		serverError(w, "suggest playlist prompt", err)
		return
	}
	writeJSON(w, map[string]string{"prompt": prompt})
}

// distinctGenres collects the unique genres across a playlist's songs, in
// first-seen order.
func distinctGenres(songs []library.PlaylistTrackBrief) []string {
	seen := map[string]bool{}
	var genres []string
	for _, s := range songs {
		for _, g := range s.Genres {
			if !seen[g] {
				seen[g] = true
				genres = append(genres, g)
			}
		}
	}
	return genres
}

// postRefinePrompt rewrites the current playlist-cover prompt per an
// instruction. Auth-gated (403) and chat-config-gated (404).
func (h *playlistHandlers) postRefinePrompt(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if h.genrePrompter == nil {
		httpError(w, http.StatusNotFound, "prompt suggestions are not configured")
		return
	}
	id := r.PathValue("id")
	var req struct {
		Current     string `json:"current"`
		Instruction string `json:"instruction"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.Current) == "" {
		httpError(w, http.StatusBadRequest, "current is required")
		return
	}
	if strings.TrimSpace(req.Instruction) == "" {
		httpError(w, http.StatusBadRequest, "instruction is required")
		return
	}
	name, _, err := h.repo.PlaylistContext(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpError(w, http.StatusNotFound, "not found")
			return
		}
		serverError(w, "playlist context", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	prompt, err := h.genrePrompter.RefinePrompt(ctx, req.Current, req.Instruction, name)
	if err != nil {
		serverError(w, "refine playlist prompt", err)
		return
	}
	writeJSON(w, map[string]string{"prompt": prompt})
}

// postCover applies a previously generated Studio cover-art image to a
// playlist: it copies the generated PNG into the deduped cover_art store and
// maps it to the playlist. Mirrors postAlbumCover almost verbatim.
// Auth-gated + image-generation-config-gated.
func (h *playlistHandlers) postCover(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if !h.cfg.ImageGenEnabled() || h.imageGen == nil {
		httpError(w, http.StatusNotFound, "studio cover art is not configured")
		return
	}
	id := r.PathValue("id")
	var req struct {
		StudioCoverArtID string `json:"studioCoverArtId"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.StudioCoverArtID) == "" {
		httpError(w, http.StatusBadRequest, "studioCoverArtId is required")
		return
	}

	// The playlist must exist; otherwise SetPlaylistCover would create a
	// dangling mapping no playlist references.
	pl, err := h.repo.GetPlaylist(r.Context(), id, true)
	if err != nil {
		serverError(w, "get playlist", err)
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
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
	if err := h.repo.SetPlaylistCover(r.Context(), id, coverID); err != nil {
		serverError(w, "apply playlist cover", err)
		return
	}
	writeJSON(w, map[string]any{"coverArtId": coverID})
}

// postSuggestDescription returns three tone-varied playlist descriptions
// grounded in the playlist's songs. Auth-gated (403) and
// chat-config-gated (404). 400 if the playlist is empty.
func (h *playlistHandlers) postSuggestDescription(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if h.descriptions == nil {
		httpError(w, http.StatusNotFound, "description suggestions are not configured")
		return
	}
	id := r.PathValue("id")
	name, songs, err := h.repo.PlaylistContext(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			httpError(w, http.StatusNotFound, "not found")
			return
		}
		serverError(w, "playlist context", err)
		return
	}
	if len(songs) == 0 {
		httpError(w, http.StatusBadRequest, "playlist has no songs")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	tones, err := h.descriptions.PlaylistDescriptions(ctx, name, songs)
	if err != nil {
		serverError(w, "suggest playlist description", err)
		return
	}
	writeJSON(w, map[string]string{
		"punchy":    tones.Punchy,
		"evocative": tones.Evocative,
		"factual":   tones.Factual,
	})
}
