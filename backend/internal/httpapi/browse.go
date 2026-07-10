package httpapi

import "net/http"

func (h *songHandlers) listArtists(w http.ResponseWriter, r *http.Request) {
	artists, err := h.repo.ListArtists(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list artists")
		return
	}
	writeJSON(w, map[string]any{"artists": artists})
}

func (h *songHandlers) getArtist(w http.ResponseWriter, r *http.Request) {
	artist, songs, err := h.repo.GetArtist(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get artist")
		return
	}
	if artist == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, map[string]any{"artist": artist, "songs": songs})
}

func (h *songHandlers) listGenres(w http.ResponseWriter, r *http.Request) {
	genres, err := h.repo.ListGenres(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list genres")
		return
	}
	writeJSON(w, map[string]any{"genres": genres})
}

func (h *songHandlers) getGenre(w http.ResponseWriter, r *http.Request) {
	genre, songs, err := h.repo.GetGenre(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get genre")
		return
	}
	if genre == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, map[string]any{"genre": genre, "songs": songs})
}
