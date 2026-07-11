package httpapi

import (
	"context"
	"net/http"
	"time"
)

// suggestPromptTimeout bounds one genre-prompt completion. A single no-tool
// completion is fast; this is a generous ceiling.
const suggestPromptTimeout = 90 * time.Second

// postGenreSuggestPrompt returns an editable example image prompt for a genre,
// authored by a one-shot LLM call. It never generates an image — the client
// drops the returned prompt into the editable box and calls /api/fanart/generate
// when the user is happy. Auth-gated (403) and chat-config-gated (404).
func (h *songHandlers) postGenreSuggestPrompt(w http.ResponseWriter, r *http.Request) {
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
	ctx, cancel := context.WithTimeout(r.Context(), suggestPromptTimeout)
	defer cancel()
	prompt, err := h.genrePrompter.GenrePrompt(ctx, g.Name)
	if err != nil {
		serverError(w, "suggest genre prompt", err)
		return
	}
	writeJSON(w, map[string]string{"prompt": prompt})
}
