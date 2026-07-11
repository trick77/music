package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// refineRequest carries the current image prompt and a natural-language
// instruction to rewrite it. Used by both the genre and album refine endpoints.
type refineRequest struct {
	Prompt      string `json:"prompt"`
	Instruction string `json:"instruction"`
}

// refinePrompt runs one LLM refine completion and writes {"prompt": ...}. context
// is optional grounding (genre name, or "Artist — Album") passed to the model.
func (h *songHandlers) refinePrompt(w http.ResponseWriter, r *http.Request, req refineRequest, groundingContext string) {
	if strings.TrimSpace(req.Prompt) == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if strings.TrimSpace(req.Instruction) == "" {
		httpError(w, http.StatusBadRequest, "instruction is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	prompt, err := h.genrePrompter.RefinePrompt(ctx, req.Prompt, req.Instruction, groundingContext)
	if err != nil {
		serverError(w, "refine prompt", err)
		return
	}
	writeJSON(w, map[string]string{"prompt": prompt})
}

// postGenreRefinePrompt rewrites the current genre-background prompt per an
// instruction. Auth-gated (403) and chat-config-gated (404).
func (h *songHandlers) postGenreRefinePrompt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.genrePrompter == nil {
		httpError(w, http.StatusNotFound, "prompt suggestions are not configured")
		return
	}
	g, _, err := h.repo.GetGenre(r.Context(), r.PathValue("id"), true) // authed-only handler
	if err != nil {
		serverError(w, "get genre", err)
		return
	}
	if g == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	var req refineRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	h.refinePrompt(w, r, req, "Genre: "+g.Name)
}

// postAlbumRefinePrompt rewrites the current album-cover prompt per an
// instruction. Auth-gated (403) and chat-config-gated (404).
func (h *songHandlers) postAlbumRefinePrompt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.genrePrompter == nil {
		httpError(w, http.StatusNotFound, "prompt suggestions are not configured")
		return
	}
	var req struct {
		refineRequest
		albumRef
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	grounding := ""
	if actx, err := h.repo.AlbumContext(r.Context(), req.ArtistID, req.Album); err == nil && actx.Exists {
		grounding = actx.ArtistName + " — " + strings.TrimSpace(req.Album)
		if len(actx.Genres) > 0 {
			grounding += " (" + strings.Join(actx.Genres, ", ") + ")"
		}
	}
	h.refinePrompt(w, r, req.refineRequest, grounding)
}
