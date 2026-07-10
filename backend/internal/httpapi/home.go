package httpapi

import "net/http"

// getHome returns the immersive Home feed (hero + sections). Public. All imagery
// is referenced by id only; no server-only fanart fields are ever included.
func (h *songHandlers) getHome(w http.ResponseWriter, r *http.Request) {
	feed, err := h.repo.HomeFeed(r.Context(), 12, 8)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "home feed")
		return
	}
	writeJSON(w, feed)
}
