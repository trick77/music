package httpapi

import "net/http"

// getSearch returns grouped search results for ?q=. Public.
func (h *songHandlers) getSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	res, err := h.repo.Search(r.Context(), q, 20)
	if err != nil {
		serverError(w, "search", err)
		return
	}
	writeJSON(w, res)
}
