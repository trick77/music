package httpapi

import (
	"encoding/json"
	"errors"
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
		serverError(w, "get song", err)
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
		serverError(w, "resolve file", err)
		return
	}
	if err := metadata.WriteTags(abs, metadata.WriteableTags{
		Title: req.Title, Artist: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres,
	}); err != nil {
		serverError(w, "write tags", err)
		return
	}
	// Refresh the recorded size from the rewritten file; if Stat fails, keep the
	// prior value rather than zeroing it.
	size := song.FileSize
	if info, err := os.Stat(abs); err == nil {
		size = info.Size()
	}

	updated, err := h.repo.Update(r.Context(), song.ID, library.UpdateSongParams{
		Title: req.Title, ArtistName: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres, FileSize: size,
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
