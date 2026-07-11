package httpapi

import (
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
)

// favoriteHandlers persists per-user favorites for logged-in users. Anonymous
// users keep favorites in browser localStorage and never hit these endpoints;
// all handlers here require authentication and key on the session username.
type favoriteHandlers struct {
	cfg  config.Config
	repo *library.Repo
}

func (h *favoriteHandlers) requireAuth(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := identify(h.cfg, r)
	if !id.Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return "", false
	}
	return id.Username, true
}

func (h *favoriteHandlers) list(w http.ResponseWriter, r *http.Request) {
	username, ok := h.requireAuth(w, r)
	if !ok {
		return
	}
	ids, err := h.repo.ListFavorites(r.Context(), username)
	if err != nil {
		serverError(w, "list favorites", err)
		return
	}
	writeJSON(w, map[string]any{"ids": ids})
}

func (h *favoriteHandlers) add(w http.ResponseWriter, r *http.Request) {
	username, ok := h.requireAuth(w, r)
	if !ok {
		return
	}
	if err := h.repo.AddFavorite(r.Context(), username, r.PathValue("id")); err != nil {
		serverError(w, "add favorite", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *favoriteHandlers) remove(w http.ResponseWriter, r *http.Request) {
	username, ok := h.requireAuth(w, r)
	if !ok {
		return
	}
	if err := h.repo.RemoveFavorite(r.Context(), username, r.PathValue("id")); err != nil {
		serverError(w, "remove favorite", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
