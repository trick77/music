package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
)

func (h *songHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	coverID, ok := storeUploadedCover(w, r, h.media, h.repo, h.maxBytes)
	if !ok {
		return
	}
	if err := h.repo.SetSongCover(r.Context(), song.ID, coverID); err != nil {
		serverError(w, "assign cover", err)
		return
	}
	updated, err := h.repo.Get(r.Context(), song.ID)
	if err != nil {
		serverError(w, "reload song", err)
		return
	}
	writeJSON(w, updated)
}

func (h *songHandlers) getCover(w http.ResponseWriter, r *http.Request) {
	path, err := h.repo.GetCoverPath(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		serverError(w, "get cover", err)
		return
	}
	serveSizedImage(w, r, h.media, path)
}
