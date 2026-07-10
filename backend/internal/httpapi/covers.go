package httpapi

import (
	"database/sql"
	"errors"
	"mime"
	"net/http"
	"path/filepath"
)

func (h *songHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
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
		httpError(w, http.StatusInternalServerError, "assign cover")
		return
	}
	updated, err := h.repo.Get(r.Context(), song.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "reload song")
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
		httpError(w, http.StatusInternalServerError, "get cover")
		return
	}
	f, err := h.media.Open(path)
	if err != nil {
		httpError(w, http.StatusNotFound, "cover file missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "stat cover")
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(path)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}
