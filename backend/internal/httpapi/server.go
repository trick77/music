package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
)

func New(cfg config.Config, st *store.Store, spa http.Handler) http.Handler {
	mux := http.NewServeMux()
	var shareRepo *library.Repo

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		id := identify(cfg, r)
		writeJSON(w, map[string]any{"authenticated": id.Authenticated, "username": id.Username})
	})

	// Song routes require a store and a media root; both are present in normal
	// runs. (Phase 1 unit tests pass st=nil and no media dir and never hit these.)
	if st != nil && cfg.MediaDir != "" {
		if mstore, err := media.New(cfg.MediaDir); err == nil {
			h := &songHandlers{
				cfg:      cfg,
				repo:     library.NewRepo(st.DB()),
				media:    mstore,
				maxBytes: int64(cfg.MaxUploadMB) * 1024 * 1024,
			}
			shareRepo = h.repo
			mux.HandleFunc("GET /api/songs", h.list)
			mux.HandleFunc("POST /api/songs", h.upload)
			mux.HandleFunc("GET /api/songs/{id}", h.get)
			mux.HandleFunc("GET /api/songs/{id}/stream", h.stream)
			mux.HandleFunc("GET /api/songs/{id}/download", h.download)
			mux.HandleFunc("PATCH /api/songs/{id}", h.patch)
			mux.HandleFunc("GET /api/suggest", h.suggest)
			mux.HandleFunc("PUT /api/songs/{id}/cover", h.putCover)
			mux.HandleFunc("GET /api/cover/{id}", h.getCover)
			mux.HandleFunc("GET /api/artists", h.listArtists)
			mux.HandleFunc("GET /api/artists/{id}", h.getArtist)
			mux.HandleFunc("GET /api/genres", h.listGenres)
			mux.HandleFunc("GET /api/genres/{id}", h.getGenre)

			pl := &playlistHandlers{cfg: cfg, repo: h.repo, media: mstore, maxBytes: int64(cfg.MaxUploadMB) * 1024 * 1024}
			mux.HandleFunc("GET /api/playlists", pl.list)
			mux.HandleFunc("GET /api/playlists/{id}", pl.get)
			mux.HandleFunc("POST /api/playlists", pl.create)
			mux.HandleFunc("PATCH /api/playlists/{id}", pl.patch)
			mux.HandleFunc("DELETE /api/playlists/{id}", pl.delete)
			mux.HandleFunc("POST /api/playlists/{id}/songs", pl.addSong)
			mux.HandleFunc("DELETE /api/playlists/{id}/songs/{songId}", pl.removeSong)
			mux.HandleFunc("PUT /api/playlists/{id}/reorder", pl.reorder)
			mux.HandleFunc("PUT /api/playlists/{id}/cover", pl.putCover)
		}
	}

	// Anything not under /api/ is the SPA. Share routes (/song/{id},
	// /playlist/{id}) get server-injected Open Graph meta for link previews.
	root := http.NewServeMux()
	root.Handle("/api/", mux)
	var spaHandler http.Handler = spa
	if shareRepo != nil {
		if shell, err := web.IndexHTML(); err == nil {
			spaHandler = withShareMeta(shareRepo, shell, spa)
		}
	}
	root.Handle("/", spaHandler)
	return root
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
