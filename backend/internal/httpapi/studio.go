package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/studio"
)

// studioRequestTimeout bounds a whole generate/refine research loop.
const studioRequestTimeout = 4 * time.Minute

// Input caps keep prompts sane and bound token spend. A song reference and a
// refine instruction are short by nature; lyrics can run longer.
const (
	maxReferenceLen   = 300
	maxInstructionLen = 500
	maxLyricsLen      = 20000
)

type studioHandlers struct {
	cfg      config.Config
	provider studio.Provider
}

// generate streams a Suno prompt for a named song as Server-Sent Events:
// `progress` events while MiMo researches, then a final `result` event (or an
// `error` event). This lets the UI show live status instead of a blank spinner.
func (h *studioHandlers) generate(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	var req struct {
		Reference string `json:"reference"`
	}
	if !decodeStudioBody(w, r, &req) {
		return
	}
	if req.Reference == "" {
		httpError(w, http.StatusBadRequest, "reference is required")
		return
	}
	if len(req.Reference) > maxReferenceLen {
		httpError(w, http.StatusBadRequest, "reference is too long")
		return
	}
	stream, flush, ok := startSSE(w)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), studioRequestTimeout)
	defer cancel()

	onProgress := func(p studio.Progress) { stream("progress", p); flush() }
	res, err := h.provider.Generate(ctx, studio.GenerateRequest{Reference: req.Reference}, onProgress)
	if err != nil {
		stream("error", map[string]string{"error": "generation failed"})
		flush()
		return
	}
	stream("result", res)
	flush()
}

// refine streams a lyrics rewrite for a named song as SSE, keeping style and
// cover-art fixed.
func (h *studioHandlers) refine(w http.ResponseWriter, r *http.Request) {
	if !h.guard(w, r) {
		return
	}
	var req struct {
		Reference   string `json:"reference"`
		Lyrics      string `json:"lyrics"`
		Instruction string `json:"instruction"`
	}
	if !decodeStudioBody(w, r, &req) {
		return
	}
	if req.Reference == "" || req.Lyrics == "" || req.Instruction == "" {
		httpError(w, http.StatusBadRequest, "reference, lyrics and instruction are required")
		return
	}
	if len(req.Reference) > maxReferenceLen || len(req.Instruction) > maxInstructionLen || len(req.Lyrics) > maxLyricsLen {
		httpError(w, http.StatusBadRequest, "input is too long")
		return
	}
	stream, flush, ok := startSSE(w)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), studioRequestTimeout)
	defer cancel()

	onProgress := func(p studio.Progress) { stream("progress", p); flush() }
	lyrics, err := h.provider.Refine(ctx, studio.RefineRequest{
		Reference: req.Reference, Lyrics: req.Lyrics, Instruction: req.Instruction,
	}, onProgress)
	if err != nil {
		stream("error", map[string]string{"error": "refinement failed"})
		flush()
		return
	}
	stream("result", map[string]string{"lyrics": lyrics})
	flush()
}

// guard enforces the shared gate: authenticated (403) and configured (404).
func (h *studioHandlers) guard(w http.ResponseWriter, r *http.Request) bool {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return false
	}
	if h.provider == nil {
		httpError(w, http.StatusNotFound, "studio is not configured")
		return false
	}
	return true
}

func decodeStudioBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return false
	}
	return true
}

// startSSE sets Server-Sent Events headers and returns writer helpers. It fails
// with 500 if the ResponseWriter cannot flush.
func startSSE(w http.ResponseWriter) (stream func(event string, data any), flush func(), ok bool) {
	flusher, canFlush := w.(http.Flusher)
	if !canFlush {
		httpError(w, http.StatusInternalServerError, "streaming unsupported")
		return nil, nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx)
	stream = func(event string, data any) {
		payload, err := json.Marshal(data)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
	}
	return stream, func() { flusher.Flush() }, true
}
