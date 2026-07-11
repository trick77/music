package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

// coverArtSize is the square album dimension (matches the prompt's
// "square album composition").
const coverArtSize = 1024

// postStudioCoverArt generates a cover-art image from a prompt synchronously,
// persists it (accumulating), and returns its id. Authed-only, gated on image
// generation being configured (BFL). Cover generation needs no web research, so
// it is NOT tied to StudioEnabled()/Tavily — the album-cover panel reuses this.
func (h *songHandlers) postStudioCoverArt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if !h.cfg.ImageGenEnabled() || h.imageGen == nil {
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
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if len([]rune(prompt)) > imagegen.MaxPromptRunes {
		httpError(w, http.StatusBadRequest, "prompt is too long")
		return
	}
	model, ok := imagegen.ResolveModel(req.Model, h.cfg.BFLModel)
	if !ok {
		httpError(w, http.StatusBadRequest, "unknown model")
		return
	}

	seed := randomSeed()
	id := library.NewID()

	genCtx, cancel := context.WithTimeout(r.Context(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()
	res, err := h.imageGen.Generate(genCtx, imagegen.GenerateRequest{
		Prompt: prompt, Width: coverArtSize, Height: coverArtSize,
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
	if err := h.repo.CreateStudioCoverArt(r.Context(), id, relPath, prompt, model, &seed, width, height); err != nil {
		// Remove the just-written PNG so a failed insert doesn't strand an
		// orphan file (there is no row referencing it, and nothing GCs the dir).
		_ = h.media.Remove(relPath)
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
