package httpapi

import (
	"fmt"
	"net/http"
	"os"

	"github.com/trick77/music/internal/library"
)

func (h *songHandlers) postFanart(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	tmp, hash, width, height, ext, ok := bufferProbeImage(w, r, h.maxBytes)
	if !ok {
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	kind := r.FormValue("kind")
	genreID := r.FormValue("genreId")
	if kind != "genre" && kind != "hero" {
		httpError(w, http.StatusBadRequest, "kind must be 'genre' or 'hero'")
		return
	}
	if kind == "genre" {
		if genreID == "" || !h.genreExists(r, genreID) {
			httpError(w, http.StatusBadRequest, "unknown genre")
			return
		}
	} else {
		genreID = ""
	}
	relPath := "fanart/" + hash + "." + ext
	if err := writeStoreFile(h.media, relPath, tmp); err != nil {
		serverError(w, "store fanart", err)
		return
	}
	id, err := h.repo.CreateFanart(r.Context(), library.FanartParams{
		Kind: kind, GenreID: genreID, ImagePath: relPath, Width: width, Height: height, Status: "ready",
	})
	if err != nil {
		_ = h.media.Remove(relPath)
		serverError(w, "save fanart", err)
		return
	}
	fa, err := h.repo.GetFanart(r.Context(), id)
	if err == nil && fa == nil {
		err = fmt.Errorf("fanart %s missing after create", id)
	}
	if err != nil {
		serverError(w, "reload fanart", err)
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, fa)
}

func (h *songHandlers) getFanart(w http.ResponseWriter, r *http.Request) {
	fa, err := h.repo.GetFanart(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get fanart", err)
		return
	}
	if fa == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if r.URL.Query().Get("meta") != "" {
		writeJSON(w, fanartMeta(fa, identify(h.cfg, r).Authenticated))
		return
	}
	if fa.Status != "ready" || fa.ImagePath == "" {
		httpError(w, http.StatusNotFound, "image not ready")
		return
	}
	serveSizedImage(w, r, h.media, fa.ImagePath)
}

// fanartMeta returns the client-safe status view. The generation prompt and model
// are NEVER included. The failure reason is included only for authenticated
// callers (the editor), never for anonymous visitors.
func fanartMeta(fa *library.Fanart, authed bool) map[string]any {
	m := map[string]any{
		"id": fa.ID, "kind": fa.Kind, "genreId": fa.GenreID, "status": fa.Status,
		"isActive": fa.IsActive, "isHero": fa.IsHero, "width": fa.Width, "height": fa.Height,
		"caption": fa.Caption,
	}
	if authed && fa.ErrorMsg != "" {
		m["error"] = fa.ErrorMsg
	}
	return m
}

func (h *songHandlers) genreExists(r *http.Request, id string) bool {
	g, _, err := h.repo.GetGenre(r.Context(), id)
	return err == nil && g != nil
}

// getGenreExtended returns a genre with its fanart gallery, active-background id,
// hero id, and accent colour. Anonymous callers never see non-ready (generating /
// failed) tiles; authenticated callers do (so the editor can show progress).
func (h *songHandlers) getGenreExtended(w http.ResponseWriter, r *http.Request) {
	genre, songs, err := h.repo.GetGenre(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get genre", err)
		return
	}
	if genre == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	all, err := h.repo.ListGenreFanart(r.Context(), genre.ID)
	if err != nil {
		serverError(w, "list fanart", err)
		return
	}
	authed := identify(h.cfg, r).Authenticated
	fanart := []library.Fanart{}
	backgroundID, heroID := "", ""
	for _, fa := range all {
		if fa.IsActive {
			backgroundID = fa.ID
		}
		if fa.IsHero {
			heroID = fa.ID
		}
		if !authed && fa.Status != "ready" {
			continue // anonymous never sees in-flight/failed tiles
		}
		fanart = append(fanart, fa)
	}
	writeJSON(w, map[string]any{
		"genre": genre, "songs": songs, "fanart": fanart,
		"backgroundId": backgroundID, "heroId": heroID,
	})
}
