package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/studio"
)

type playlistHandlers struct {
	cfg           config.Config
	repo          *library.Repo
	media         *media.Store
	maxBytes      int64
	genrePrompter studio.GenrePrompter
	descriptions  studio.DescriptionWriter
	imageGen      imagegen.Provider
}

func (h *playlistHandlers) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return false
	}
	return true
}

func (h *playlistHandlers) list(w http.ResponseWriter, r *http.Request) {
	pls, err := h.repo.ListPlaylists(r.Context(), identify(h.cfg, r).Authenticated)
	if err != nil {
		serverError(w, "list playlists", err)
		return
	}
	writeJSON(w, map[string]any{"playlists": pls})
}

func (h *playlistHandlers) publish(w http.ResponseWriter, r *http.Request)   { h.setPublished(w, r, true) }
func (h *playlistHandlers) unpublish(w http.ResponseWriter, r *http.Request) { h.setPublished(w, r, false) }

// setPublished flips a playlist's publish state. Authenticated-only (mirrors the
// other playlist writes); responds with the updated detail, or 404 if unknown.
func (h *playlistHandlers) setPublished(w http.ResponseWriter, r *http.Request, published bool) {
	if !h.requireAuth(w, r) {
		return
	}
	id := r.PathValue("id")
	found, err := h.repo.SetPlaylistPublished(r.Context(), id, published)
	if err != nil {
		serverError(w, "set playlist published", err)
		return
	}
	if !found {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) get(w http.ResponseWriter, r *http.Request) {
	pl, err := h.repo.GetPlaylist(r.Context(), r.PathValue("id"), identify(h.cfg, r).Authenticated)
	if err != nil {
		serverError(w, "get playlist", err)
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

// playlistPatchBody distinguishes an omitted field from an empty one, so
// PATCH can update only the description without resending the name.
type playlistPatchBody struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
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
		serverError(w, "create playlist", err)
		return
	}
	h.respondDetail(w, r, id, http.StatusCreated)
}

func (h *playlistHandlers) patch(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body playlistPatchBody
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Name != nil && *body.Name == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	id := r.PathValue("id")
	description := ""
	if body.Description != nil {
		description = *body.Description
	}
	if body.Name == nil {
		if err := h.repo.UpdatePlaylistDescription(r.Context(), id, description); err != nil {
			serverError(w, "update playlist", err)
			return
		}
	} else {
		if err := h.repo.UpdatePlaylist(r.Context(), id, *body.Name, description); err != nil {
			serverError(w, "update playlist", err)
			return
		}
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) delete(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if err := h.repo.DeletePlaylist(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, "delete playlist", err)
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
		serverError(w, "add song", err)
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
		serverError(w, "remove song", err)
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
		serverError(w, "reorder playlist", err)
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	id := r.PathValue("id")
	pl, err := h.repo.GetPlaylist(r.Context(), id, true) // auth-gated write path; see all tracks
	if err != nil {
		serverError(w, "get playlist", err)
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	coverID, ok := storeUploadedCover(w, r, h.media, h.repo, h.maxBytes)
	if !ok {
		return
	}
	if err := h.repo.SetPlaylistCover(r.Context(), id, coverID); err != nil {
		serverError(w, "assign cover", err)
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

// respondDetail reloads and writes the playlist detail with the given status.
// Only reached from auth-gated write handlers, so unpublished tracks are shown.
func (h *playlistHandlers) respondDetail(w http.ResponseWriter, r *http.Request, id string, status int) {
	pl, err := h.repo.GetPlaylist(r.Context(), id, true)
	if err != nil {
		serverError(w, "reload playlist", err)
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
