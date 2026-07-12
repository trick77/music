package httpapi

import (
	"database/sql"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const playCooldown = 30 * time.Second

// playThrottle rejects a repeated play of the same song from the same client
// within playCooldown. It is a LIGHT, in-memory guard against refresh/replay
// abuse — the primary once-per-listen dedup happens client-side (spec §9). No
// PII is persisted: keys live only in memory and are opportunistically swept.
type playThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newPlayThrottle() *playThrottle { return &playThrottle{seen: map[string]time.Time{}} }

// allow reports whether a play for key is accepted at time now, recording the
// time if so. A play at exactly the cooldown boundary is allowed again.
func (p *playThrottle) allow(key string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if last, ok := p.seen[key]; ok && now.Sub(last) < playCooldown {
		return false
	}
	p.seen[key] = now
	if len(p.seen) > 4096 { // opportunistic sweep so the map can't grow unbounded
		for k, t := range p.seen {
			if now.Sub(t) >= playCooldown {
				delete(p.seen, k)
			}
		}
	}
	return true
}

// clientIP is the throttle key's client component. The deploy always sits
// behind Traefik (compose.yaml), which sets X-Forwarded-For to the real
// client address, so that header is trusted here; its leftmost entry is the
// original client, added by the hop closest to them. Falls back to
// r.RemoteAddr (the proxy's own address) when the header is absent, e.g. in
// tests or a direct connection.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if ip := strings.TrimSpace(strings.SplitN(xff, ",", 2)[0]); ip != "" {
			return ip
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// postPlay records a qualified play. PUBLIC BY DESIGN — spec §12 lists
// POST /api/songs/{id}/play as anonymous-OK: recording plays is the single
// deliberate public write in the app. Every OTHER write stays auth-gated.
func (h *songHandlers) postPlay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	song, err := h.repo.Get(r.Context(), id)
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if h.throttle.allow(clientIP(r)+"|"+id, time.Now()) {
		if err := h.repo.RecordPlay(r.Context(), id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				httpError(w, http.StatusNotFound, "not found")
				return
			}
			serverError(w, "record play", err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// getTopTen returns the deterministic ten-most-played chart. Public.
func (h *songHandlers) getTopTen(w http.ResponseWriter, r *http.Request) {
	entries, err := h.repo.TopTen(r.Context(), identify(h.cfg, r).Authenticated)
	if err != nil {
		serverError(w, "top ten", err)
		return
	}
	writeJSON(w, map[string]any{"songs": entries})
}
