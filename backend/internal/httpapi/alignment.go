package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/trick77/music/internal/align"
)

// aligner is the alignment sidecar seam; *align.Client satisfies it, tests stub it.
type aligner interface {
	Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*align.Result, error)
}

// postAlign kicks off word-timing alignment for a song. Auth-gated; 404 when the
// aligner is unconfigured; 409 if an alignment is already generating for the song.
func (h *songHandlers) postAlign(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.aligner == nil {
		httpError(w, http.StatusNotFound, "alignment is not configured")
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
	if song.Lyrics == "" {
		httpError(w, http.StatusBadRequest, "song has no lyrics to align")
		return
	}
	if existing, err := h.repo.GetAlignment(r.Context(), song.ID); err != nil {
		serverError(w, "get alignment", err)
		return
	} else if existing != nil && existing.Status == "generating" {
		httpError(w, http.StatusConflict, "alignment already in progress")
		return
	}
	if err := h.repo.UpsertGeneratingAlignment(r.Context(), song.ID); err != nil {
		serverError(w, "start alignment", err)
		return
	}
	go h.runAlignment(song.ID, song.FilePath, song.Lyrics)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"status": "generating"})
}

// runAlignment drives one alignment to completion on a detached context and records
// the terminal state (fanart pattern). Audio streams from the stored file.
func (h *songHandlers) runAlignment(songID, relPath, lyrics string) {
	if h.onAlignComplete != nil {
		defer h.onAlignComplete(songID)
	}
	slog.Info("alignment started", "song", songID)
	f, err := h.media.Open(relPath)
	if err != nil {
		h.failAlignment(songID, "open audio: "+err.Error())
		return
	}
	defer f.Close()

	genCtx, cancel := context.WithTimeout(context.Background(), h.cfg.AlignTimeout+30*time.Second)
	defer cancel()
	res, err := h.aligner.Align(genCtx, f, filepath.Base(relPath), lyrics)
	if err != nil {
		h.failAlignment(songID, err.Error())
		return
	}
	data, err := json.Marshal(res.Lines)
	if err != nil {
		h.failAlignment(songID, "encode timings: "+err.Error())
		return
	}
	// Persist on a fresh context so an expired genCtx can't strand the row.
	persistCtx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pcancel()
	if err := h.repo.MarkAlignmentReady(persistCtx, songID, res.Engine, string(data)); err != nil {
		slog.Error("alignment: record failed", "song", songID, "err", err)
		return
	}
	slog.Info("alignment completed", "song", songID, "lines", len(res.Lines))
}

func (h *songHandlers) failAlignment(songID, reason string) {
	slog.Error("alignment failed", "song", songID, "reason", reason)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = h.repo.MarkAlignmentFailed(ctx, songID, reason)
}

// getAlign returns the song's alignment status and, when ready, its line timings.
// The server-only failure reason is never included.
func (h *songHandlers) getAlign(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	a, err := h.repo.GetAlignment(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get alignment", err)
		return
	}
	if a == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	out := map[string]any{"status": a.Status}
	if a.Status == "ready" {
		out["engine"] = a.Engine
		out["lines"] = json.RawMessage(a.Data) // already-encoded []Line
	}
	writeJSON(w, out)
}
