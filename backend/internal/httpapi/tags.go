package httpapi

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/metadata"
)

type editSongRequest struct {
	Title      string   `json:"title"`
	ArtistName string   `json:"artistName"`
	Album      string   `json:"album"`
	Year       int      `json:"year"`
	TrackNo    int      `json:"trackNo"`
	Genres     []string `json:"genres"`
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
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}

	// Write to the FILE first (crash-safe rename inside WriteTags): if this fails
	// the DB is untouched.
	abs, err := h.media.Resolve(song.FilePath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "resolve file")
		return
	}
	if err := metadata.WriteTags(abs, metadata.WriteableTags{
		Title: req.Title, Artist: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres,
	}); err != nil {
		httpError(w, http.StatusInternalServerError, "write tags")
		return
	}
	var size int64
	if info, err := os.Stat(abs); err == nil {
		size = info.Size()
	}

	updated, err := h.repo.Update(r.Context(), song.ID, library.UpdateSongParams{
		Title: req.Title, ArtistName: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres, FileSize: size,
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "update song")
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
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid suggest field")
		return
	}
	writeJSON(w, map[string]any{"suggestions": out})
}
