package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
	"github.com/trick77/music/internal/mcp"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/internal/studio"
	"github.com/trick77/music/web"
)

// New builds the app handler with generation wired from cfg (a real BFL client
// when a key is set) and no OIDC authenticator (dev mode / tests).
func New(cfg config.Config, st *store.Store, spa http.Handler) http.Handler {
	return build(cfg, st, spa, nil, nil, nil, nil, nil)
}

// NewWithProvider builds the app handler, allowing an image-generation Provider
// and a completion hook to be injected (used by tests). When gen is nil and
// generation is configured, a real BFL client is built.
func NewWithProvider(cfg config.Config, st *store.Store, spa http.Handler, gen imagegen.Provider, onGenComplete func(string)) http.Handler {
	return build(cfg, st, spa, gen, onGenComplete, nil, nil, nil)
}

// NewWithStudioProvider builds the app handler with a Studio Provider injected
// (used by tests so no live LLM/MCP calls are made).
func NewWithStudioProvider(cfg config.Config, st *store.Store, spa http.Handler, sp studio.Provider) http.Handler {
	return build(cfg, st, spa, nil, nil, nil, sp, nil)
}

// NewWithGenrePrompter builds the app handler with an image-generation Provider
// and a genre-prompt suggester injected (used by tests so no live LLM call is
// made). Mirrors NewWithProvider but also wires the suggest-prompt route.
func NewWithGenrePrompter(cfg config.Config, st *store.Store, spa http.Handler, gen imagegen.Provider, onGenComplete func(string), gp studio.GenrePrompter) http.Handler {
	return build(cfg, st, spa, gen, onGenComplete, nil, nil, gp)
}

// NewWithAuth builds the app handler with an OIDC Authenticator wired in
// (production oidc mode and the auth-flow tests). A nil authr registers no
// login/callback/logout routes.
func NewWithAuth(cfg config.Config, st *store.Store, spa http.Handler, authr *auth.Authenticator) http.Handler {
	return build(cfg, st, spa, nil, nil, authr, nil, nil)
}

func build(cfg config.Config, st *store.Store, spa http.Handler, gen imagegen.Provider, onGenComplete func(string), authr *auth.Authenticator, studioProvider studio.Provider, genrePrompter studio.GenrePrompter) http.Handler {
	mux := http.NewServeMux()
	var shareRepo *library.Repo

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		id := identify(cfg, r)
		writeJSON(w, map[string]any{
			"authenticated":   id.Authenticated,
			"username":        id.Username,
			"imageGenEnabled": cfg.ImageGenEnabled() && id.Authenticated,
			"studioEnabled":   cfg.StudioEnabled() && id.Authenticated,
			"chatEnabled":     cfg.ChatEnabled() && id.Authenticated,
			"authMode":        string(cfg.AuthMode),
		})
	})

	// Studio (Phase 9) — independent of the library store. A real MiMo provider
	// (LLM + Tavily/fetch MCP research loop) is built when studio is configured
	// and none was injected (tests inject their own). A nil provider makes the
	// routes answer 404, which is what a disabled instance looks like.
	if studioProvider == nil && cfg.StudioEnabled() {
		servers := map[string]mcp.ServerConfig{
			"tavily": mcp.TavilyServerConfig(cfg.TavilyURL, cfg.TavilyAPIKey),
		}
		if cfg.FetchMCPURL != "" {
			servers["fetch"] = mcp.FetchServerConfig(cfg.FetchMCPURL)
		}
		studioProvider = studio.New(
			&llm.Client{BaseURL: cfg.ChatBaseURL, APIKey: cfg.ChatAPIKey, Model: "mimo-v2.5-pro", ReasoningEffort: "high"},
			mcp.NewService(servers, nil),
		)
	}
	sh := &studioHandlers{cfg: cfg, provider: studioProvider}
	mux.HandleFunc("POST /api/studio/generate", sh.generate)
	mux.HandleFunc("POST /api/studio/refine", sh.refine)

	// OIDC login/callback/logout — only in oidc mode with a configured provider.
	if authr != nil {
		ah := &authHandlers{cfg: cfg, authr: authr, secure: cfg.OIDC.CookieSecure}
		mux.HandleFunc("GET /api/auth/login", ah.login)
		mux.HandleFunc("GET /api/auth/callback", ah.callback)
		mux.HandleFunc("GET /api/auth/logout", ah.logout)
	}

	// Song routes require a store and a media root; both are present in normal
	// runs. (Phase 1 unit tests pass st=nil and no media dir and never hit these.)
	if st != nil && cfg.MediaDir != "" {
		if mstore, err := media.New(cfg.MediaDir); err == nil {
			// Real BFL client when generation is configured and no provider was
			// injected (tests inject their own).
			if gen == nil && cfg.ImageGenEnabled() {
				gen = imagegen.NewBFLClient(imagegen.BFLConfig{
					BaseURL: cfg.BFLBaseURL, APIKey: cfg.BFLAPIKey, Model: cfg.BFLModel,
					PollTimeout: cfg.BFLPollTimeout,
				})
			}
			// Real one-shot genre-prompt suggester when the chat key is set and none
			// was injected. Independent of Studio (no Tavily/MCP research loop).
			if genrePrompter == nil && cfg.ChatEnabled() {
				genrePrompter = studio.NewGenrePrompter(
					&llm.Client{BaseURL: cfg.ChatBaseURL, APIKey: cfg.ChatAPIKey, Model: "mimo-v2.5-pro", ReasoningEffort: "high"},
				)
			}
			h := &songHandlers{
				cfg:           cfg,
				repo:          library.NewRepo(st.DB()),
				media:         mstore,
				maxBytes:      int64(cfg.MaxUploadMB) * 1024 * 1024,
				imageGen:      gen,
				bflModel:      cfg.BFLModel,
				onGenComplete: onGenComplete,
				genrePrompter: genrePrompter,
				throttle:      newPlayThrottle(),
			}
			// Reap generation rows orphaned by a prior restart (their goroutines
			// are gone) so they don't show a permanent spinner.
			_, _ = h.repo.FailOrphanedGenerating(context.Background())
			shareRepo = h.repo
			mux.HandleFunc("GET /api/songs", h.list)
			mux.HandleFunc("POST /api/songs", h.upload)
			mux.HandleFunc("GET /api/songs/{id}", h.get)
			mux.HandleFunc("GET /api/songs/{id}/stream", h.stream)
			mux.HandleFunc("GET /api/songs/{id}/download", h.download)
			mux.HandleFunc("POST /api/songs/{id}/publish", h.publish)
			mux.HandleFunc("POST /api/songs/{id}/unpublish", h.unpublish)
			mux.HandleFunc("POST /api/songs/{id}/play", h.postPlay) // PUBLIC — the one documented anonymous write (spec §12)
			mux.HandleFunc("GET /api/top-ten", h.getTopTen)
			mux.HandleFunc("GET /api/home", h.getHome)
			mux.HandleFunc("GET /api/search", h.getSearch)
			mux.HandleFunc("PATCH /api/songs/{id}", h.patch)
			mux.HandleFunc("DELETE /api/songs/{id}", h.delete)
			mux.HandleFunc("GET /api/suggest", h.suggest)
			mux.HandleFunc("PUT /api/songs/{id}/cover", h.putCover)
			mux.HandleFunc("GET /api/cover/{id}", h.getCover)
			mux.HandleFunc("GET /api/artists", h.listArtists)
			mux.HandleFunc("GET /api/artists/{id}", h.getArtist)
			mux.HandleFunc("GET /api/genres", h.listGenres)
			mux.HandleFunc("GET /api/genres/{id}", h.getGenreExtended)
			mux.HandleFunc("PATCH /api/genres/{id}", h.patchGenre)
			mux.HandleFunc("POST /api/genres/{id}/suggest-prompt", h.postGenreSuggestPrompt)
			mux.HandleFunc("POST /api/fanart", h.postFanart)
			mux.HandleFunc("GET /api/fanart/{id}", h.getFanart)
			mux.HandleFunc("POST /api/fanart/generate", h.postFanartGenerate)
			mux.HandleFunc("POST /api/studio/coverart", h.postStudioCoverArt)
			mux.HandleFunc("GET /api/studio/coverart/{id}", h.getStudioCoverArt)

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
	return logging(recovery(root))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
