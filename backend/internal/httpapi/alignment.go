package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"path/filepath"
	"strings"
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
	// Claim + enqueue atomically: started is false if one is already generating, so
	// concurrent POSTs can't both spawn a (minutes-long) job for the same song.
	started, err := h.enqueueAlignment(r.Context(), song.ID, song.FilePath, song.Lyrics)
	if err != nil {
		serverError(w, "start alignment", err)
		return
	}
	if !started {
		httpError(w, http.StatusConflict, "alignment already in progress")
		return
	}
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"status": "generating"})
}

// alignJob is one queued alignment: the song id, its stored relative path, and the
// lyrics to align against.
type alignJob struct {
	songID  string
	relPath string
	lyrics  string
}

// initAlignQueue creates the queue and starts the single serial worker. Called
// once at server init and by tests. Safe to call once per handler.
func (h *songHandlers) initAlignQueue() {
	h.alignQueue = make(chan alignJob, 1024)
	go h.alignWorker()
}

// enqueueAlignment is the single funnel every trigger (manual, import, save) uses.
// It claims the alignment slot synchronously (so the row flips to generating and
// 202/409 semantics hold) then hands the job to the one serial worker. It no-ops
// on a disabled aligner, blank lyrics, or a slot already generating.
func (h *songHandlers) enqueueAlignment(ctx context.Context, songID, relPath, lyrics string) (bool, error) {
	if h.aligner == nil || h.alignQueue == nil || strings.TrimSpace(lyrics) == "" {
		return false, nil
	}
	started, err := h.repo.StartAlignment(ctx, songID)
	if err != nil || !started {
		return started, err
	}
	// Send on a goroutine so a full buffer can never block an HTTP handler; the row
	// is already claimed, so the job is guaranteed to run when the worker reaches it.
	// The single worker still executes jobs strictly one at a time.
	go func() { h.alignQueue <- alignJob{songID: songID, relPath: relPath, lyrics: lyrics} }()
	return true, nil
}

// alignWorker drains the queue, running exactly one alignment at a time. Each
// runAlignment recovers its own panic, so one bad job cannot kill the worker.
func (h *songHandlers) alignWorker() {
	for job := range h.alignQueue {
		h.runAlignment(job.songID, job.relPath, job.lyrics)
	}
}

// runAlignment drives one alignment to completion on a detached context and records
// the terminal state (fanart pattern). Audio streams from the stored file.
func (h *songHandlers) runAlignment(songID, relPath, lyrics string) {
	if h.onAlignComplete != nil {
		defer h.onAlignComplete(songID)
	}
	// A panic in this detached goroutine would otherwise crash the whole process;
	// mark the row failed instead so the song just shows a failed alignment.
	defer func() {
		if p := recover(); p != nil {
			h.failAlignment(songID, fmt.Sprintf("alignment panicked: %v", p))
		}
	}()
	started := time.Now()
	slog.Info("alignment started", "song", songID, "queued", len(h.alignQueue))
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
		slog.Error("alignment failed", "song", songID, "elapsed", time.Since(started).Round(time.Millisecond), "err", err)
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
	st := summarizeAlignment(res)
	slog.Info("alignment completed",
		"song", songID,
		"engine", res.Engine,
		"elapsed", time.Since(started).Round(time.Millisecond),
		"lines", len(res.Lines),
		"words", st.words,
		"span", st.spanSeconds(),
		"lowConfPct", st.lowConfPct(),
	)
}

// alignStats are the conversion metrics logged on a completed alignment, mirroring
// the Phase 2.5 quality checks (coverage span + low-confidence share).
type alignStats struct {
	words     int
	lowConf   int     // words with conf < 0.4
	firstWord float64 // start of the first word
	lastWord  float64 // end of the last word
}

func (s alignStats) spanSeconds() float64 {
	if s.words == 0 {
		return 0
	}
	return math.Round((s.lastWord-s.firstWord)*10) / 10
}

func (s alignStats) lowConfPct() int {
	if s.words == 0 {
		return 0
	}
	return int(math.Round(float64(s.lowConf) / float64(s.words) * 100))
}

func summarizeAlignment(res *align.Result) alignStats {
	st := alignStats{firstWord: math.Inf(1)}
	for _, ln := range res.Lines {
		for _, w := range ln.Words {
			st.words++
			if w.Conf < 0.4 {
				st.lowConf++
			}
			if w.Start < st.firstWord {
				st.firstWord = w.Start
			}
			if w.End > st.lastWord {
				st.lastWord = w.End
			}
		}
	}
	if st.words == 0 {
		st.firstWord = 0
	}
	return st
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
