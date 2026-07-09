# Music Player — Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a bootable single-image app — Go backend serving an embedded React SPA, backed by pure-Go SQLite with a migration runner, with dev-mode autologin — that renders the loom design system and reports auth state.

**Architecture:** Mirror `../loom` exactly: a Go (`net/http`) backend under `backend/`, a Vite + React 19 + TS + Tailwind v4 SPA under `ui/` built into `backend/web/dist` and embedded via `//go:embed`. One SQLite file (`ncruces/go-sqlite3`, `CGO_ENABLED=0`). Config from `BACKEND_*` env. Auth has a `dev` mode (fixed full-access user, no round-trip) now; real OIDC lands in a later phase.

**Tech Stack:** Go 1.25, `github.com/ncruces/go-sqlite3` v0.23.3, stdlib `net/http`; React 19, Vite, TypeScript, Tailwind v4.

## Global Constraints

- Module path `github.com/trick77/music`. Go `1.25.0`. `CGO_ENABLED=0` everywhere.
- Pure-Go SQLite `github.com/ncruces/go-sqlite3` pinned to **`v0.23.3`**. Do NOT use `mattn/go-sqlite3`.
- **No AI branding or wordmark in any UI copy.** No `ß` in any German text (use `ss`) — though app copy is English.
- Design tokens are loom's CSS variables verbatim: bg `#1f1f1e`, panel `#1b1b1a`, active `#2c2c2a`, border `#323230`, ink `#faf9f5`, muted `#9c9a92`, accent `#c6613f`, accent-strong `#d97757`, radius `10px`. Fonts: self-hosted Anthropic Sans/Serif variable fonts.
- YAML files use `.yaml` (never `.yml`). Docs/code/comments in English.
- TDD: write the failing test first. Conventional commits. Feature branch per phase (`feat/phase-1-foundation`); never commit to `master`.
- Repo has `AGENTS.md`, not `CLAUDE.md`.
- **Playwright validation at every stage.** Any task that produces a runnable surface (an endpoint or a screen) ends by driving the *running* app with the Playwright MCP browser tools (`mcp__plugin_playwright_playwright__browser_*`) — navigate, snapshot, click, assert visible text/behaviour — not just Go/Vitest unit tests. Each phase closes with a Playwright end-to-end pass over its new functionality.
- **Review-agent gate before every merge.** Before any PR is merged, dispatch a generic code-review agent (e.g. the `Agent` tool with `subagent_type: "general-purpose"` or the `code-review` skill) over the PR diff; address findings before merging. Never self-merge unreviewed.

---

## Phase roadmap (context — only Phase 1 is detailed here)

Each phase produces working, testable software and gets its own plan file when reached. **Every
phase ends with a Playwright end-to-end validation of its new functionality and a generic
review-agent pass on its PR before merge.**

1. **Foundation** (this plan) — repo skeleton, config, SQLite + migrations, HTTP server, dev autologin, embedded SPA shell, single-image build.
2. **Songs & playback** — song model, managed store, upload + ID3 parse, range-request streaming + download, a basic song list that plays.
3. **Artists, genres & tags** — artists, many-to-many genres, tag editor + typeahead, artist+album cover auto-match.
4. **Playlists, queue, favorites, share** — playlist CRUD + reorder, queue, localStorage favorites, public share links + OG previews.
5. **Fanart & image generation** — `fanart` model, genre background editor, BFL/FLUX generation, `imagescale` variants.
6. **Immersive frontend** — the full mockup screens (home, detail, player, library, search, mobile, empty), MediaSession/PWA, resume playback.
7. **Production auth & deploy** — OIDC against Authentik (group-gated), single-image Containerfile, compose, `.env.example`, reverse-proxy notes.

The authoritative design is [`docs/superpowers/specs/2026-07-09-music-player-design.md`](../specs/2026-07-09-music-player-design.md); the visual reference is [`docs/mockups/music-player-mockup.html`](../../mockups/music-player-mockup.html).

---

## File structure (Phase 1)

- `backend/go.mod` — Go module `github.com/trick77/music`.
- `backend/internal/config/config.go` — env loader, `Config`, `AuthMode`, `DevUserConfig`. One responsibility: parse+validate env.
- `backend/internal/store/store.go` — open SQLite, run migrations. `backend/internal/store/migrations/0001_init.sql` — core schema.
- `backend/internal/httpapi/server.go` — router, health, session endpoint. `backend/internal/httpapi/auth.go` — auth middleware + identity.
- `backend/web/embed.go` — `//go:embed all:dist` + SPA handler. `backend/web/dist/index.html` — tracked placeholder.
- `backend/cmd/music/main.go` — wire config → store → server → listen.
- `ui/` — Vite + React + TS + Tailwind scaffold; `ui/src/index.css` (loom tokens + fonts), `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/fonts/*` (copied from loom).
- Root: `Makefile`, `compose.dev.yaml`, `.env.example`, `AGENTS.md`, `.gitignore`.

---

## Task 1: Config loader

**Files:**
- Create: `backend/go.mod`, `backend/internal/config/config.go`
- Test: `backend/internal/config/config_test.go`

**Interfaces:**
- Produces: `config.Load() (Config, error)`; `Config{ AuthMode AuthMode; DevUser DevUserConfig; DBPath string; MediaDir string; MaxUploadMB int; SessionSecret string; ListenAddr string }`; consts `AuthModeDev AuthMode = "dev"`, `AuthModeOIDC AuthMode = "oidc"`; `DevUserConfig{ Username string }`.

- [ ] **Step 1: Initialize the Go module**

Run:
```bash
mkdir -p backend/internal/config
cd backend && go mod init github.com/trick77/music && go mod edit -go=1.25.0
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/config/config_test.go`:
```go
package config

import "testing"

func TestLoad_devDefaults(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "test-secret")
	t.Setenv("BACKEND_AUTH_MODE", "dev")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.AuthMode != AuthModeDev {
		t.Fatalf("AuthMode = %q, want dev", cfg.AuthMode)
	}
	if cfg.DevUser.Username != "dev" {
		t.Fatalf("DevUser.Username = %q, want dev", cfg.DevUser.Username)
	}
	if cfg.DBPath == "" || cfg.MediaDir == "" {
		t.Fatalf("DBPath/MediaDir must have defaults, got %q / %q", cfg.DBPath, cfg.MediaDir)
	}
}

func TestLoad_requiresSessionSecret(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when BACKEND_SESSION_SECRET is empty")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/config/ -run TestLoad -v`
Expected: FAIL (undefined `Load`, `AuthModeDev`, …).

- [ ] **Step 4: Write minimal implementation**

Create `backend/internal/config/config.go`:
```go
// Package config loads runtime configuration from BACKEND_* environment vars.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type AuthMode string

const (
	AuthModeDev  AuthMode = "dev"
	AuthModeOIDC AuthMode = "oidc"
)

type DevUserConfig struct {
	Username string
}

type Config struct {
	AuthMode      AuthMode
	DevUser       DevUserConfig
	DBPath        string
	MediaDir      string
	MaxUploadMB   int
	SessionSecret string
	ListenAddr    string
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func Load() (Config, error) {
	cfg := Config{
		AuthMode:      AuthMode(strings.TrimSpace(env("BACKEND_AUTH_MODE", "dev"))),
		DevUser:       DevUserConfig{Username: env("BACKEND_DEV_USER_USERNAME", "dev")},
		DBPath:        env("BACKEND_DB_PATH", "data/music.db"),
		MediaDir:      env("BACKEND_MEDIA_DIR", "data/media"),
		SessionSecret: env("BACKEND_SESSION_SECRET", ""),
		ListenAddr:    env("BACKEND_LISTEN_ADDR", ":8080"),
	}
	mb, err := strconv.Atoi(env("BACKEND_MAX_UPLOAD_MB", "50"))
	if err != nil || mb <= 0 {
		return Config{}, fmt.Errorf("BACKEND_MAX_UPLOAD_MB must be a positive integer")
	}
	cfg.MaxUploadMB = mb
	if cfg.SessionSecret == "" {
		return Config{}, fmt.Errorf("BACKEND_SESSION_SECRET is required")
	}
	if cfg.AuthMode != AuthModeDev && cfg.AuthMode != AuthModeOIDC {
		return Config{}, fmt.Errorf("BACKEND_AUTH_MODE must be 'dev' or 'oidc', got %q", cfg.AuthMode)
	}
	return cfg, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/go.mod backend/internal/config/
git commit -m "feat(config): BACKEND_* env loader with dev/oidc auth modes"
```

---

## Task 2: SQLite store + migration runner + core schema

**Files:**
- Create: `backend/internal/store/store.go`, `backend/internal/store/migrations/0001_init.sql`
- Test: `backend/internal/store/store_test.go`

**Interfaces:**
- Consumes: none.
- Produces: `store.Open(dbPath string) (*store.Store, error)`; `(*Store).DB() *sql.DB`; `(*Store).Close() error`. `Open` runs all embedded migrations in filename order and records them in `schema_migrations`.

- [ ] **Step 1: Add the SQLite dependency**

Run:
```bash
cd backend && go get github.com/ncruces/go-sqlite3@v0.23.3 && go get github.com/ncruces/go-sqlite3/driver@v0.23.3
```

- [ ] **Step 2: Write the core schema migration**

Create `backend/internal/store/migrations/0001_init.sql`:
```sql
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE artists (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE          -- case-folded match key
);

CREATE TABLE cover_art (
    id           TEXT PRIMARY KEY,
    image_path   TEXT NOT NULL,
    width        INTEGER NOT NULL DEFAULT 0,
    height       INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE songs (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album        TEXT,                      -- optional tag
    year         INTEGER,
    track_no     INTEGER,
    duration_ms  INTEGER NOT NULL DEFAULT 0,
    file_path    TEXT NOT NULL,             -- managed-store relative path
    file_size    INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    cover_art_id TEXT REFERENCES cover_art(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_songs_artist ON songs(artist_id);
CREATE INDEX idx_songs_album ON songs(artist_id, album);

CREATE TABLE genres (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE song_genres (
    song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    genre_id   TEXT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, genre_id)
);
CREATE INDEX idx_song_genres_genre ON song_genres(genre_id);

CREATE TABLE playlists (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    cover_art_id TEXT REFERENCES cover_art(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE playlist_songs (
    playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, song_id)
);

CREATE TABLE fanart (
    id         TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('hero', 'genre')),
    genre_id   TEXT REFERENCES genres(id) ON DELETE CASCADE,
    caption    TEXT,
    prompt     TEXT,                        -- when generated
    model      TEXT,
    is_active  INTEGER NOT NULL DEFAULT 0,  -- active background for its genre
    is_hero    INTEGER NOT NULL DEFAULT 0,  -- starred as featured Home hero
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fanart_genre ON fanart(genre_id);

CREATE TABLE plays (
    id        TEXT PRIMARY KEY,
    song_id   TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plays_song ON plays(song_id);
CREATE INDEX idx_plays_at ON plays(played_at);
```

- [ ] **Step 3: Write the failing test**

Create `backend/internal/store/store_test.go`:
```go
package store

import (
	"path/filepath"
	"testing"
)

func TestOpen_runsMigrations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error: %v", err)
	}
	defer st.Close()

	// Core tables must exist.
	for _, tbl := range []string{"songs", "artists", "genres", "song_genres", "playlists", "fanart", "plays", "schema_migrations"} {
		var name string
		err := st.DB().QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("table %q missing: %v", tbl, err)
		}
	}

	// Re-opening must be idempotent (migrations already recorded).
	st2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("re-Open() error: %v", err)
	}
	st2.Close()
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/ -v`
Expected: FAIL (undefined `Open`).

- [ ] **Step 5: Write minimal implementation**

Create `backend/internal/store/store.go`:
```go
// Package store opens the SQLite database and applies embedded migrations.
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct{ db *sql.DB }

func (s *Store) DB() *sql.DB { return s.db }
func (s *Store) Close() error { return s.db.Close() }

func Open(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var exists string
		err := s.db.QueryRow(`SELECT name FROM schema_migrations WHERE name=?`, name).Scan(&exists)
		if err == nil {
			continue // already applied
		}
		body, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(string(body)); err != nil {
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := s.db.Exec(`INSERT INTO schema_migrations(name) VALUES (?)`, name); err != nil {
			return fmt.Errorf("record migration %s: %w", name, err)
		}
	}
	return nil
}
```

- [ ] **Step 6: Run test + tidy**

Run: `cd backend && go mod tidy && go test ./internal/store/ -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/store/ backend/go.mod backend/go.sum
git commit -m "feat(store): SQLite open + migration runner + core schema"
```

---

## Task 3: HTTP server — health, auth middleware, session endpoint

**Files:**
- Create: `backend/internal/httpapi/server.go`, `backend/internal/httpapi/auth.go`
- Test: `backend/internal/httpapi/server_test.go`

**Interfaces:**
- Consumes: `config.Config`, `*store.Store`.
- Produces: `httpapi.New(cfg config.Config, st *store.Store, spa http.Handler) http.Handler`. Routes: `GET /api/health` → `{"status":"ok"}`; `GET /api/auth/session` → `{"authenticated":bool,"username":string}`. `Identity{ Authenticated bool; Username string }` derived per request (dev mode ⇒ always authenticated as `DevUser.Username`; oidc stub ⇒ anonymous for now). Non-`/api/` paths delegate to `spa`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/httpapi/server_test.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func testHandler(t *testing.T, mode config.AuthMode) http.Handler {
	t.Helper()
	cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, nil, spa)
}

func TestHealth(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/api/health", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestSession_devIsAuthenticated(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	var body struct {
		Authenticated bool   `json:"authenticated"`
		Username      string `json:"username"`
	}
	json.NewDecoder(rr.Body).Decode(&body)
	if !body.Authenticated || body.Username != "dev" {
		t.Fatalf("session = %+v, want authenticated dev", body)
	}
}

func TestSession_oidcAnonymousByDefault(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeOIDC).ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	var body struct {
		Authenticated bool `json:"authenticated"`
	}
	json.NewDecoder(rr.Body).Decode(&body)
	if body.Authenticated {
		t.Fatal("oidc with no session should be anonymous in Phase 1")
	}
}

func TestSPAFallthrough(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/anything", nil))
	if rr.Body.String() != "SPA" {
		t.Fatalf("non-api path should hit SPA, got %q", rr.Body.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -v`
Expected: FAIL (undefined `New`).

- [ ] **Step 3: Write the auth identity helper**

Create `backend/internal/httpapi/auth.go`:
```go
package httpapi

import (
	"net/http"

	"github.com/trick77/music/internal/config"
)

// Identity is the caller's auth state for a request.
type Identity struct {
	Authenticated bool
	Username      string
}

// identify resolves the caller. Phase 1: dev mode is always the full-access
// dev user; oidc mode is anonymous until real OIDC sessions land in Phase 7.
func identify(cfg config.Config, _ *http.Request) Identity {
	if cfg.AuthMode == config.AuthModeDev {
		return Identity{Authenticated: true, Username: cfg.DevUser.Username}
	}
	return Identity{Authenticated: false}
}
```

- [ ] **Step 4: Write the server**

Create `backend/internal/httpapi/server.go`:
```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/httpapi/ -v`
Expected: PASS (all four).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/httpapi/
git commit -m "feat(httpapi): server with health, session, dev identity, SPA fallthrough"
```

---

## Task 4: Embedded SPA + minimal loom-styled frontend + main + build

**Files:**
- Create: `backend/web/embed.go`, `backend/web/dist/index.html` (tracked placeholder), `backend/cmd/music/main.go`
- Create: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/index.css`, `ui/src/fonts/*`
- Test: `backend/web/embed_test.go`

**Interfaces:**
- Consumes: `httpapi.New`, `config.Load`, `store.Open`.
- Produces: `web.SPAHandler() http.Handler` serving `dist` with SPA fallback to `index.html`; a runnable `cmd/music` binary.

- [ ] **Step 1: Copy loom's fonts and write the placeholder dist**

Run:
```bash
mkdir -p backend/web/dist ui/src/fonts
cp ../loom/ui/src/fonts/SansWebVariable-TextRegular.woff2 ui/src/fonts/
cp ../loom/ui/src/fonts/SerifWebVariable-TextRegularItalic.woff2 ui/src/fonts/ 2>/dev/null || true
cp ../loom/ui/src/fonts/SerifWebVariable-TextRegular.woff2 ui/src/fonts/
printf '<!doctype html><meta charset="utf-8"><title>Music</title><div id="root">build the UI: make fe-build</div>' > backend/web/dist/index.html
```

- [ ] **Step 2: Write the embed test**

Create `backend/web/embed_test.go`:
```go
package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSPAHandler_servesIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestSPAHandler_unknownFallsBackToIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/library", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("SPA route should serve index, status = %d", rr.Code)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./web/ -v`
Expected: FAIL (undefined `SPAHandler`).

- [ ] **Step 4: Write the embed handler**

Create `backend/web/embed.go`:
```go
// Package web embeds the built frontend (web/dist) and serves it as a SPA.
package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var distFS embed.FS

// SPAHandler serves the embedded dist directory; unknown paths fall back to
// index.html so client-side routing works.
func SPAHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err) // dist is embedded at build time; a failure is a programmer error
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(sub, trimLeadingSlash(r.URL.Path)); err != nil && r.URL.Path != "/" {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}

func trimLeadingSlash(p string) string {
	if len(p) > 0 && p[0] == '/' {
		return p[1:]
	}
	return p
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./web/ -v`
Expected: PASS.

- [ ] **Step 6: Write main.go**

Create `backend/cmd/music/main.go`:
```go
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/httpapi"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		log.Fatalf("mkdir db dir: %v", err)
	}
	if err := os.MkdirAll(cfg.MediaDir, 0o755); err != nil {
		log.Fatalf("mkdir media dir: %v", err)
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	handler := httpapi.New(cfg, st, web.SPAHandler())
	log.Printf("music listening on %s (auth=%s)", cfg.ListenAddr, cfg.AuthMode)
	if err := http.ListenAndServe(cfg.ListenAddr, handler); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
```

- [ ] **Step 7: Scaffold the frontend (mirror loom)**

Create `ui/package.json`:
```json
{
  "name": "music-ui",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest"
  },
  "dependencies": { "react": "^19.2.7", "react-dom": "^19.2.7" },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.1",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.2",
    "tailwindcss": "^4.3.0",
    "typescript": "^6.0.3",
    "vite": "^8.0.16",
    "vitest": "^4.1.7"
  }
}
```

Create `ui/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "../backend/web/dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8080" } },
});
```

Create `ui/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client"]
  },
  "include": ["src"]
}
```

Create `ui/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Music</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

Create `ui/src/index.css` (loom tokens + fonts — abbreviated font-faces; copy all @font-face blocks from `../loom/ui/src/index.css`):
```css
@import "tailwindcss";

@font-face { font-family: "Anthropic Sans"; src: url("./fonts/SansWebVariable-TextRegular.woff2") format("woff2"); font-weight: 300 800; font-display: swap; }
@font-face { font-family: "Anthropic Serif"; src: url("./fonts/SerifWebVariable-TextRegular.woff2") format("woff2"); font-weight: 300 800; font-display: swap; }

@theme {
  --color-bg: #1f1f1e; --color-panel: #1b1b1a; --color-active: #2c2c2a; --color-border: #323230;
  --color-ink: #faf9f5; --color-muted: #9c9a92; --color-accent: #c6613f; --color-accent-strong: #d97757;
  --font-sans: "Anthropic Sans", system-ui, sans-serif;
  --font-serif: "Anthropic Serif", Georgia, serif;
  --radius-ui: 10px;
}
html { color-scheme: dark; }
body { margin: 0; background: var(--color-bg); color: var(--color-ink); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
```

Create `ui/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
```

Create `ui/src/App.tsx`:
```tsx
import { useEffect, useState } from "react";

type Session = { authenticated: boolean; username: string };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    fetch("/api/auth/session").then((r) => r.json()).then(setSession).catch(() => setSession({ authenticated: false, username: "" }));
  }, []);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "2rem", margin: 0 }}>Music</h1>
        <p style={{ color: "var(--color-muted)" }}>
          {session == null ? "…" : session.authenticated ? `Signed in as ${session.username}` : "Browsing as guest"}
        </p>
      </div>
    </main>
  );
}
```

- [ ] **Step 8: Build the frontend and run the full binary**

Run:
```bash
cd ui && npm install && npm run build
cd ../backend && BACKEND_SESSION_SECRET=dev-secret go run ./cmd/music &
sleep 2 && curl -s localhost:8080/api/health && curl -s localhost:8080/api/auth/session && kill %1
```
Expected: `{"status":"ok"}` then `{"authenticated":true,"username":"dev"}`.

- [ ] **Step 9: Restore the tracked dist placeholder**

The build overwrote `backend/web/dist`; only the placeholder is tracked (built assets are git-ignored in Task 5).

Run:
```bash
printf '<!doctype html><meta charset="utf-8"><title>Music</title><div id="root">build the UI: make fe-build</div>' > backend/web/dist/index.html
```

- [ ] **Step 10: Commit**

```bash
git add backend/web/embed.go backend/web/embed_test.go backend/web/dist/index.html backend/cmd/ ui/package.json ui/vite.config.ts ui/tsconfig.json ui/index.html ui/src/
git commit -m "feat(web): embedded SPA + loom-styled shell reading auth session"
```

---

## Task 5: Build tooling, single-image, env example, AGENTS.md

**Files:**
- Create: `Makefile`, `compose.dev.yaml`, `.env.example`, `AGENTS.md`, `.gitignore`, `backend/Containerfile`

**Interfaces:** none (tooling).

- [ ] **Step 1: Write `.gitignore`**

Create `.gitignore`:
```gitignore
/bin/
/data/
node_modules/
ui/dist/
# Built SPA assets are not tracked; only the placeholder index.html is.
backend/web/dist/*
!backend/web/dist/index.html
.env
```

- [ ] **Step 2: Write the Makefile (mirror loom)**

Create `Makefile`:
```make
.PHONY: build test fe-build fe-test run tidy docker-dev docker-dev-down

tidy:
	cd backend && go mod tidy

test:
	cd backend && go test ./...

fe-test:
	cd ui && npm run test -- --run

fe-build:
	cd ui && npm ci && npm run build

build: fe-build
	cd backend && CGO_ENABLED=0 go build -o ../bin/music ./cmd/music

run:
	cd backend && go run ./cmd/music

docker-dev:
	docker compose -f compose.dev.yaml up --build --remove-orphans

docker-dev-down:
	docker compose -f compose.dev.yaml down
```

- [ ] **Step 3: Write `.env.example`** (copy the block verbatim from the spec §13)

Create `.env.example`:
```dotenv
# --- Core (required) ---
BACKEND_SESSION_SECRET=change-me-to-a-long-random-string
BACKEND_DB_PATH=/data/music.db
BACKEND_MEDIA_DIR=/data/media
BACKEND_MAX_UPLOAD_MB=50

# --- Auth ---
# Local development: dev = autologin as a fixed full-access user, no Authentik needed.
BACKEND_AUTH_MODE=dev
BACKEND_DEV_USER_USERNAME=dev
# Production: set BACKEND_AUTH_MODE=oidc and fill these (Authentik "music" application).
BACKEND_OIDC_ISSUER=https://auth.trick77.com/application/o/music/
BACKEND_OIDC_CLIENT_ID=
BACKEND_OIDC_CLIENT_SECRET=
BACKEND_OIDC_REDIRECT_URL=https://music.trick77.com/api/auth/callback
BACKEND_OIDC_POST_LOGOUT_REDIRECT_URL=https://music.trick77.com/
BACKEND_OIDC_ALLOWED_GROUP=

# --- Image generation (optional; leave API key empty to disable the Generate button) ---
BACKEND_BFL_BASE_URL=https://api.bfl.ai/v1
BACKEND_BFL_API_KEY=
BACKEND_BFL_MODEL=flux-2-klein-4b
BACKEND_BFL_POLL_TIMEOUT=1m
```

- [ ] **Step 4: Write the single-image Containerfile**

Create `backend/Containerfile`:
```dockerfile
# Stage 1: build the SPA
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci || npm install
COPY ui/ ./
RUN npm run build

# Stage 2: build the Go binary with the embedded SPA
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY backend/go.mod backend/go.sum ./backend/
RUN cd backend && go mod download
COPY backend/ ./backend/
COPY --from=ui /backend/web/dist ./backend/web/dist
RUN cd backend && CGO_ENABLED=0 go build -o /music ./cmd/music

# Stage 3: runtime
FROM alpine:3.20
RUN adduser -D -u 10001 app
USER app
COPY --from=build /music /music
EXPOSE 8080
ENTRYPOINT ["/music"]
```

- [ ] **Step 5: Write `compose.dev.yaml`**

Create `compose.dev.yaml`:
```yaml
services:
  music:
    build:
      context: .
      dockerfile: backend/Containerfile
    ports:
      - "8080:8080"
    environment:
      BACKEND_SESSION_SECRET: dev-secret-change-me
      BACKEND_AUTH_MODE: dev
      BACKEND_DB_PATH: /data/music.db
      BACKEND_MEDIA_DIR: /data/media
    volumes:
      - music-data:/data
volumes:
  music-data:
```

- [ ] **Step 6: Write `AGENTS.md`** (lean, loom-style — steering rules only)

Create `AGENTS.md`:
```markdown
# music

Self-hosted, song-first music player: Go backend serving a JSON API + an embedded React SPA.

## Working conventions
- English only in docs/code/comments. TDD: failing test first, then minimal impl.
- One feature branch per phase (`feat/phase-N-...`); never commit to `master`. Conventional commits.
- Keep files focused — one responsibility each. `.yaml`, never `.yml`.
- No AI branding or wordmark in any UI copy.
- **Validate every runnable change with Playwright** (Playwright MCP browser tools) against the
  running app — real navigation/clicks/assertions, not only unit tests.
- **Every PR gets a generic code-review agent pass before merge**; address findings first. Never
  self-merge unreviewed. PRs target this repo's `master`, never an upstream.

## Locked technical choices
- Module `github.com/trick77/music`, Go 1.25, `CGO_ENABLED=0`.
- Pure-Go SQLite `ncruces/go-sqlite3` v0.23.3 (never `mattn/go-sqlite3`). One SQLite file.
- HTTP: stdlib `net/http` (Go 1.22 method routing), no framework.
- Design tokens = loom's `--*` CSS variables + self-hosted Anthropic fonts. Accent = clay #c6613f / #d97757.

## Commands
- `make test` / `make fe-test` — backend Go tests / frontend Vitest.
- `make fe-build` — build SPA into `backend/web/dist` (embedded by Go; do not commit built assets).
- `make build` — full single binary → `bin/music`. `make run` — local (needs `BACKEND_SESSION_SECRET`).
- `make docker-dev` — single-image stack on :8080 with dev autologin.

## Migrations
- Add `backend/internal/store/migrations/NNNN_*.sql`; runner applies pending ones in order. Never edit an applied migration.

## Security invariants
- Every write endpoint is gated to the authenticated role; anonymous can only read/play/download/share.
- Media/image file access is sandboxed under the configured roots — reject `..`, absolute paths, symlink escape.
- Secrets via env only; never commit them.
```

- [ ] **Step 7: Verify the whole build**

Run:
```bash
make build && BACKEND_SESSION_SECRET=x ./bin/music &
sleep 2 && curl -s localhost:8080/api/health && kill %1
```
Expected: `{"status":"ok"}`.

- [ ] **Step 8: Commit**

```bash
git add Makefile compose.dev.yaml .env.example AGENTS.md .gitignore backend/Containerfile
git commit -m "chore: build tooling, single-image Containerfile, env example, AGENTS.md"
```

---

## Task 6: Playwright end-to-end smoke validation

**Files:** none (drives the running app; no code committed unless a fixture script is added).

**Interfaces:** Consumes the running binary from Task 5.

- [ ] **Step 1: Start the app**

Run: `make build && BACKEND_SESSION_SECRET=x ./bin/music &` then `sleep 2`.

- [ ] **Step 2: Drive it with Playwright MCP**

Using the Playwright MCP browser tools:
- `browser_navigate` → `http://localhost:8080/`
- `browser_snapshot` — confirm the accessibility tree contains the heading **"Music"** and the text **"Signed in as dev"** (dev autologin).
- `browser_navigate` → `http://localhost:8080/library` (an unknown SPA route) and confirm it still renders the app shell (SPA fallback works, no 404 page).

Expected: both assertions pass; the loom-styled shell renders with the embedded fonts.

- [ ] **Step 3: Tear down and record the result**

Run: `kill %1`. Note the Playwright pass in the PR description.

- [ ] **Step 4: Open the PR and gate on review**

```bash
git push -u origin feat/phase-1-foundation
```
Then, **before merging**, dispatch a generic review agent over the diff (Agent tool `subagent_type: "general-purpose"`, or the `code-review` skill), address any findings, and only then merge the PR. Confirm the PR targets **this repo's** `master`, not any upstream.

---

## Self-review notes

- **Spec coverage (Phase 1 scope):** stack mirror (§3) ✓, config/env (§13) ✓, SQLite + migrations + core schema for all entities (§5) ✓, dev autologin (§4) ✓, embedded SPA + loom tokens (§3,§15) ✓, single image + `.env.example` (§3,§13) ✓, `AGENTS.md` (§3) ✓. Streaming, upload, auth-OIDC, playlists, fanart, generation, and the full screens are **later phases** by design.
- **Types:** `config.Config` fields consumed by `main.go`/`httpapi` match Task 1. `store.Open`/`Store.DB` match Task 2–3. `httpapi.New(cfg, st, spa)` and `web.SPAHandler()` match Task 4.
- **Placeholders:** none — every code step is complete.
- **Deferred to Phase 7 (noted, not gaps):** the `.env.example` includes OIDC/BFL vars that Phase 1's config loader doesn't parse yet; that's intentional so the file is copy-once, and later phases extend `config.Load`.
