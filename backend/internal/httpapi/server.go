package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

func New(cfg config.Config, _ *store.Store, spa http.Handler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		id := identify(cfg, r)
		writeJSON(w, map[string]any{"authenticated": id.Authenticated, "username": id.Username})
	})

	// Anything not under /api/ is the SPA.
	root := http.NewServeMux()
	root.Handle("/api/", mux)
	root.Handle("/", spa)
	return root
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
