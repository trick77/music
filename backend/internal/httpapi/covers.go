package httpapi

import (
	"database/sql"
	"errors"
	"fmt"
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

// deleteCover clears a song's cover. Album-wide, mirroring putCover: an album
// track clears the whole artist+album, a single clears itself. Auth-gated.
func (h *songHandlers) deleteCover(w http.ResponseWriter, r *http.Request) {
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
	if err := h.repo.RemoveSongCover(r.Context(), song.ID); err != nil {
		serverError(w, "remove cover", err)
		return
	}
	updated, err := h.repo.Get(r.Context(), song.ID)
	if err != nil {
		serverError(w, "reload song", err)
		return
	}
	writeJSON(w, updated)
}

// downloadCover serves a song's cover art as an attachment. It is song-scoped
// rather than cover-scoped (unlike getCover) because covers are album-wide: a
// cover id alone has no single song to name the file after, so the download is
// named after the track the user clicked.
//
// Signed-in only, like the other cover write/manage routes — anonymous listeners
// can view art inline via GET /api/cover/{id} but cannot pull the original file.
func (h *songHandlers) downloadCover(w http.ResponseWriter, r *http.Request) {
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
	if song.CoverArtID == "" {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	relPath, err := h.repo.GetCoverPath(r.Context(), song.CoverArtID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && relPath == "") {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		serverError(w, "get cover", err)
		return
	}
	// Extension comes from the stored file — covers may be JPEG or PNG.
	name := downloadBase(song) + filepath.Ext(relPath)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	serveStoreFile(w, r, h.media, relPath)
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
