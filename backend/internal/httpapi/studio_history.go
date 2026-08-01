package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// History page sizes. defaultHistoryLimit is what the drawer asks for; the hard
// cap stops a hand-written query from pulling the whole table into one response
// once a long-lived install has hundreds of runs.
const (
	defaultHistoryLimit = 25
	maxHistoryLimit     = 50
)

// listStudioHistory returns one page of runs, newest first, with the total so the
// drawer can render "25 of N". Paging is keyset on rowid: a run written while the
// user is paging cannot shift the window and duplicate a row, which OFFSET would.
func (h *songHandlers) listStudioHistory(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	limit := defaultHistoryLimit
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = v
	}
	if limit > maxHistoryLimit {
		limit = maxHistoryLimit
	}
	// A junk cursor parses to 0, which is exactly "start from the newest" — a
	// hand-edited URL gets the first page rather than an error.
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)

	runs, err := h.repo.ListStudioRuns(r.Context(), limit, before)
	if err != nil {
		serverError(w, "list studio history", err)
		return
	}
	total, err := h.repo.CountStudioRuns(r.Context())
	if err != nil {
		serverError(w, "count studio history", err)
		return
	}
	// nextBefore is 0 on the last page, which is how the drawer knows to drop its
	// "Show 25 more" button. A short page is always the last one.
	var nextBefore int64
	if len(runs) == limit {
		nextBefore = runs[len(runs)-1].RowID
	}
	writeJSON(w, map[string]any{"runs": runs, "total": total, "nextBefore": nextBefore})
}

// getStudioHistoryRun returns one saved run in full — every field it produced,
// which is the whole point of keeping it.
func (h *songHandlers) getStudioHistoryRun(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	run, err := h.repo.GetStudioRun(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get studio run", err)
		return
	}
	if run == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, run)
}

// patchStudioHistoryRun updates the saved copy of a run in place: a hand edit to
// the lyrics, or the id of a cover image just generated for it. Both fields are
// pointers so an absent key means "leave it alone" — a lyrics edit must not clear
// an attached image. It never counts as a refine; only the refine endpoint does.
func (h *songHandlers) patchStudioHistoryRun(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	var req struct {
		Lyrics     *string `json:"lyrics"`
		CoverArtID *string `json:"coverArtId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	id := r.PathValue("id")
	run, err := h.repo.GetStudioRun(r.Context(), id)
	if err != nil {
		serverError(w, "get studio run", err)
		return
	}
	if run == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if req.Lyrics != nil {
		if len(*req.Lyrics) > maxLyricsLen {
			httpError(w, http.StatusBadRequest, "lyrics are too long")
			return
		}
		if err := h.repo.UpdateStudioRunLyrics(r.Context(), id, *req.Lyrics, false); err != nil {
			serverError(w, "update studio run lyrics", err)
			return
		}
	}
	if req.CoverArtID != nil {
		if err := h.repo.UpdateStudioRunCoverArt(r.Context(), id, *req.CoverArtID); err != nil {
			serverError(w, "update studio run cover art", err)
			return
		}
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// deleteStudioHistoryRun removes a run. The cover art it referenced is left in
// place on purpose: studio_coverart owns those rows and their PNGs, nothing
// tracks whether another surface still serves the image, and a broken image
// elsewhere costs more than a few hundred unreferenced KB.
func (h *songHandlers) deleteStudioHistoryRun(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if err := h.repo.DeleteStudioRun(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, "delete studio run", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
