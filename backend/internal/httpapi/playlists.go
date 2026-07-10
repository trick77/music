package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
)

type playlistHandlers struct {
	cfg  config.Config
	repo *library.Repo
}

func (h *playlistHandlers) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return false
	}
	return true
}

func (h *playlistHandlers) list(w http.ResponseWriter, r *http.Request) {
	pls, err := h.repo.ListPlaylists(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list playlists")
		return
	}
	writeJSON(w, map[string]any{"playlists": pls})
}

func (h *playlistHandlers) get(w http.ResponseWriter, r *http.Request) {
	pl, err := h.repo.GetPlaylist(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get playlist")
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, pl)
}

type playlistBody struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *playlistHandlers) create(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body playlistBody
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Name == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	id, err := h.repo.CreatePlaylist(r.Context(), body.Name, body.Description)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "create playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusCreated)
}

func (h *playlistHandlers) patch(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body playlistBody
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Name == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.UpdatePlaylist(r.Context(), id, body.Name, body.Description); err != nil {
		httpError(w, http.StatusInternalServerError, "update playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) delete(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if err := h.repo.DeletePlaylist(r.Context(), r.PathValue("id")); err != nil {
		httpError(w, http.StatusInternalServerError, "delete playlist")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *playlistHandlers) addSong(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body struct {
		SongID string `json:"songId"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.SongID == "" {
		httpError(w, http.StatusBadRequest, "songId is required")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.AddSong(r.Context(), id, body.SongID); err != nil {
		httpError(w, http.StatusInternalServerError, "add song")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) removeSong(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	id := r.PathValue("id")
	if err := h.repo.RemoveSong(r.Context(), id, r.PathValue("songId")); err != nil {
		httpError(w, http.StatusInternalServerError, "remove song")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) reorder(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body struct {
		SongIDs []string `json:"songIds"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.Reorder(r.Context(), id, body.SongIDs); err != nil {
		if errors.Is(err, library.ErrReorderMismatch) {
			httpError(w, http.StatusBadRequest, "reorder set does not match playlist")
			return
		}
		httpError(w, http.StatusInternalServerError, "reorder playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

// respondDetail reloads and writes the playlist detail with the given status.
func (h *playlistHandlers) respondDetail(w http.ResponseWriter, r *http.Request, id string, status int) {
	pl, err := h.repo.GetPlaylist(r.Context(), id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "reload playlist")
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSONStatus(w, status, pl)
}

// decodeJSON reads a small JSON body with a 1 MiB cap.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v)
}
