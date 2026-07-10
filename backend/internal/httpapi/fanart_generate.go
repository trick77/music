package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
)

const (
	genWidth  = 1344
	genHeight = 768
)

type generateRequest struct {
	Prompt  string `json:"prompt"`
	Kind    string `json:"kind"`
	GenreID string `json:"genreId"`
}

func (h *songHandlers) postFanartGenerate(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.imageGen == nil {
		httpError(w, http.StatusNotFound, "image generation is not configured")
		return
	}
	var req generateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Prompt == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if req.Kind != "genre" && req.Kind != "hero" {
		httpError(w, http.StatusBadRequest, "kind must be 'genre' or 'hero'")
		return
	}
	if req.Kind == "genre" && (req.GenreID == "" || !h.genreExists(r, req.GenreID)) {
		httpError(w, http.StatusBadRequest, "unknown genre")
		return
	}
	if req.Kind == "hero" {
		req.GenreID = ""
	}
	id, err := h.repo.CreateGeneratingFanart(r.Context(), req.Kind, req.GenreID, req.Prompt, h.bflModel, nil)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "create fanart")
		return
	}
	go h.runGeneration(id, req.Prompt)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"id": id, "status": "generating"})
}

// runGeneration drives one BFL generation to completion on a detached context and
// records the terminal state. The prompt/model live only in the DB (never served).
func (h *songHandlers) runGeneration(id, prompt string) {
	if h.onGenComplete != nil {
		defer h.onGenComplete(id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()

	res, err := h.imageGen.Generate(ctx, imagegen.GenerateRequest{
		Prompt: prompt, Width: genWidth, Height: genHeight, OutputFormat: "png",
	})
	if err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, err.Error())
		return
	}
	ext := res.Extension
	if ext == "" {
		ext = "png"
	}
	relPath := "fanart/" + id + "." + ext
	if err := writeBytes(h.media, relPath, res.Bytes); err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, "store generated image")
		return
	}
	width, height := res.Width, res.Height
	if pw, ph, _, perr := imageutil.Probe(bytes.NewReader(res.Bytes)); perr == nil {
		width, height = pw, ph
	}
	if err := h.repo.MarkFanartReady(ctx, id, relPath, width, height); err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, "record generated image")
	}
}
