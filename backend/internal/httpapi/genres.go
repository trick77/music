package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

type patchGenreRequest struct {
	Name               *string `json:"name"`
	BackgroundFanartID *string `json:"backgroundFanartId"`
	HeroFanartID       *string `json:"heroFanartId"`
	ClearHero          *string `json:"clearHero"`
}

func (h *songHandlers) patchGenre(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	genreID := r.PathValue("id")
	g, _, err := h.repo.GetGenre(r.Context(), genreID, true) // existence only; song list discarded
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get genre")
		return
	}
	if g == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	var req patchGenreRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Name != nil {
		if *req.Name == "" {
			httpError(w, http.StatusBadRequest, "name cannot be empty")
			return
		}
		if err := h.repo.UpdateGenreName(r.Context(), genreID, *req.Name); err != nil {
			httpError(w, http.StatusInternalServerError, "rename genre")
			return
		}
	}
	if req.BackgroundFanartID != nil {
		if err := h.repo.SetActiveBackground(r.Context(), genreID, *req.BackgroundFanartID); err != nil {
			if errors.Is(err, library.ErrFanartNotInGenre) {
				httpError(w, http.StatusBadRequest, "image is not a ready background for this genre")
				return
			}
			httpError(w, http.StatusInternalServerError, "set background")
			return
		}
		h.resampleAccent(r, genreID, *req.BackgroundFanartID)
	}
	if req.HeroFanartID != nil {
		if err := h.repo.SetHero(r.Context(), *req.HeroFanartID); err != nil {
			if errors.Is(err, library.ErrFanartNotInGenre) {
				httpError(w, http.StatusBadRequest, "image is not ready")
				return
			}
			httpError(w, http.StatusInternalServerError, "set hero")
			return
		}
	}
	if req.ClearHero != nil {
		if err := h.repo.ClearHero(r.Context(), *req.ClearHero); err != nil {
			httpError(w, http.StatusInternalServerError, "clear hero")
			return
		}
	}
	h.getGenreExtended(w, r) // return the fresh state
}

// resampleAccent reads the background image and stores its mean colour as the
// genre accent. Best-effort: a sampling failure leaves the prior accent intact.
func (h *songHandlers) resampleAccent(r *http.Request, genreID, fanartID string) {
	fa, err := h.repo.GetFanart(r.Context(), fanartID)
	if err != nil || fa == nil || fa.ImagePath == "" {
		return
	}
	f, err := h.media.Open(fa.ImagePath)
	if err != nil {
		return
	}
	data, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		return
	}
	hex, err := imageutil.AverageColor(bytes.NewReader(data))
	if err != nil {
		return
	}
	_ = h.repo.SetGenreAccent(r.Context(), genreID, hex)
}
