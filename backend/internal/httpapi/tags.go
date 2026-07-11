package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/trick77/music/internal/library"
)

type editSongRequest struct {
	Title      string   `json:"title"`
	ArtistName string   `json:"artistName"`
	Album      string   `json:"album"`
	Year       int      `json:"year"`
	TrackNo    int      `json:"trackNo"`
	Genres     []string `json:"genres"`
	Lyrics     string   `json:"lyrics"`
}

func (h *songHandlers) patch(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	var req editSongRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Title == "" {
		httpError(w, http.StatusBadRequest, "title is required")
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

	// The DB is the source of truth for tags: an edit only updates the row. The
	// stored file is left untouched (so its size is unchanged); current tags are
	// baked into the bytes on the fly at download time, not here.
	updated, err := h.repo.Update(r.Context(), song.ID, library.UpdateSongParams{
		Title: req.Title, ArtistName: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres, Lyrics: req.Lyrics, FileSize: song.FileSize,
	})
	if err != nil {
		serverError(w, "update song", err)
		return
	}
	writeJSON(w, updated)
}

func (h *songHandlers) suggest(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	field := r.URL.Query().Get("field")
	q := r.URL.Query().Get("q")
	out, err := h.repo.Suggest(r.Context(), field, q)
	if errors.Is(err, library.ErrUnknownSuggestField) {
		httpError(w, http.StatusBadRequest, "invalid suggest field")
		return
	}
	if err != nil {
		serverError(w, "suggest", err)
		return
	}
	writeJSON(w, map[string]any{"suggestions": out})
}
