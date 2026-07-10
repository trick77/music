package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

// coverArtModels is the allowlist of BFL models the Studio cover-art picker may
// request. The value becomes a URL path segment in the BFL call, so only known
// models are accepted; anything else is rejected before any upstream request.
var coverArtModels = map[string]bool{
	"flux-2-klein-4b": true,
	"flux-2-flex":     true,
	"flux-2-pro":      true,
}

// coverArtSize is the square album dimension (matches the prompt's
// "square album composition").
const coverArtSize = 1024

// postStudioCoverArt generates a cover-art image from a prompt synchronously,
// persists it (accumulating), and returns its id. Authed-only, both-keys gate:
// Studio configured (chat+Tavily) AND image generation configured (BFL).
func (h *songHandlers) postStudioCoverArt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if !h.cfg.StudioEnabled() || !h.cfg.ImageGenEnabled() || h.imageGen == nil {
		httpError(w, http.StatusNotFound, "studio cover art is not configured")
		return
	}
	var req struct {
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Prompt == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if len([]rune(req.Prompt)) > imagegen.MaxPromptRunes {
		httpError(w, http.StatusBadRequest, "prompt is too long")
		return
	}
	model := req.Model
	if model == "" {
		model = h.cfg.BFLModel
	} else if !coverArtModels[model] {
		httpError(w, http.StatusBadRequest, "unknown model")
		return
	}

	seed := randomSeed()
	id := library.NewID()

	genCtx, cancel := context.WithTimeout(r.Context(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()
	res, err := h.imageGen.Generate(genCtx, imagegen.GenerateRequest{
		Prompt: req.Prompt, Width: coverArtSize, Height: coverArtSize,
		OutputFormat: "png", Seed: &seed, Model: model,
	})
	if err != nil {
		// Never leak the prompt or upstream detail to the client.
		httpError(w, http.StatusBadGateway, "cover art generation failed")
		return
	}
	relPath := "coverart/" + id + ".png"
	if err := writeBytes(h.media, relPath, res.Bytes); err != nil {
		httpError(w, http.StatusInternalServerError, "store generated image")
		return
	}
	width, height := res.Width, res.Height
	if pw, ph, _, perr := imageutil.Probe(bytes.NewReader(res.Bytes)); perr == nil {
		width, height = pw, ph
	}
	if err := h.repo.CreateStudioCoverArt(r.Context(), id, relPath, req.Prompt, model, &seed, width, height); err != nil {
		httpError(w, http.StatusInternalServerError, "record generated image")
		return
	}
	writeJSON(w, map[string]any{"id": id, "status": "ready", "width": width, "height": height})
}

// getStudioCoverArt serves a generated cover-art image. Authed-only, unlike the
// public fanart backgrounds.
func (h *songHandlers) getStudioCoverArt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	c, err := h.repo.GetStudioCoverArt(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get cover art")
		return
	}
	if c == nil || c.Status != "ready" || c.ImagePath == "" {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	serveSizedImage(w, r, h.media, c.ImagePath)
}
