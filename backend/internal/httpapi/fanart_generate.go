package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
)

// randomSeed returns a non-negative seed for a generation request. Recording it
// (spec §8a) lets the same image be reproduced later. Bounded to uint32 to stay
// within BFL's accepted seed range.
func randomSeed() int64 {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return int64(binary.BigEndian.Uint32(b[:]))
}

const (
	genWidth  = 1344
	genHeight = 768
)

type generateRequest struct {
	Prompt  string `json:"prompt"`
	Kind    string `json:"kind"`
	GenreID string `json:"genreId"`
	Model   string `json:"model"`
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
	model, ok := imagegen.ResolveModel(req.Model, h.bflModel)
	if !ok {
		httpError(w, http.StatusBadRequest, "unknown model")
		return
	}
	seed := randomSeed()
	id, err := h.repo.CreateGeneratingFanart(r.Context(), req.Kind, req.GenreID, req.Prompt, model, &seed)
	if err != nil {
		serverError(w, "create fanart", err)
		return
	}
	go h.runGeneration(id, req.Prompt, model, seed)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"id": id, "status": "generating"})
}

// runGeneration drives one BFL generation to completion on a detached context and
// records the terminal state. The prompt/model live only in the DB (never served).
func (h *songHandlers) runGeneration(id, prompt, model string, seed int64) {
	if h.onGenComplete != nil {
		defer h.onGenComplete(id)
	}
	slog.Info("fanart generation started", "id", id)
	genCtx, cancel := context.WithTimeout(context.Background(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()

	res, err := h.imageGen.Generate(genCtx, imagegen.GenerateRequest{
		Prompt: prompt, Width: genWidth, Height: genHeight, OutputFormat: "png", Seed: &seed, Model: model,
	})
	// Persist the terminal state on a FRESH context: if the generation deadline
	// expired (or genCtx was canceled), reusing it here would make the state
	// write fail its context precheck and strand the row in 'generating' forever.
	persistCtx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pcancel()
	if err != nil {
		slog.Error("fanart generation failed", "id", id, "err", err)
		_ = h.repo.MarkFanartFailed(persistCtx, id, err.Error())
		return
	}
	ext := res.Extension
	if ext == "" {
		ext = "png"
	}
	relPath := "fanart/" + id + "." + ext
	if err := writeBytes(h.media, relPath, res.Bytes); err != nil {
		slog.Error("fanart generation: store image failed", "id", id, "err", err)
		_ = h.repo.MarkFanartFailed(persistCtx, id, "store generated image")
		return
	}
	width, height := res.Width, res.Height
	if pw, ph, _, perr := imageutil.Probe(bytes.NewReader(res.Bytes)); perr == nil {
		width, height = pw, ph
	}
	if err := h.repo.MarkFanartReady(persistCtx, id, relPath, width, height); err != nil {
		slog.Error("fanart generation: record image failed", "id", id, "err", err)
		_ = h.repo.MarkFanartFailed(persistCtx, id, "record generated image")
		return
	}
	slog.Info("fanart generation completed", "id", id, "width", width, "height", height)
}
