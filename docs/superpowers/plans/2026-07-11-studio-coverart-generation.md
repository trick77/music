# Studio Cover-Art Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio's cover-art prompt generate a real, downloadable square album image via the existing BFL image-generation infrastructure, gated on `studioEnabled && imageGenEnabled`.

**Architecture:** A synchronous `POST /api/studio/coverart` handler on the existing `songHandlers` calls `imagegen.Provider.Generate()` inline (it polls BFL internally), writes a PNG to the media store and a row to a dedicated `studio_coverart` table, and returns the id. A `GET /api/studio/coverart/{id}` serves the image (authed-only) by reusing `serveSizedImage`. The React `StudioPage` gains an editable cover-art prompt and a `CoverArtCard` with a model picker, generate/regenerate, inline view, and download.

**Tech Stack:** Go 1.x (net/http, database/sql, SQLite), React + TypeScript (Vite, vitest, `renderToStaticMarkup`), BFL FLUX.2 image API.

## Global Constraints

- Backend `go test ./...` must stay green. The known-flaky `TestHomeFeed_recentNewestFirstWithLimit` fails on master too — ignore it, do not "fix" it.
- Frontend must pass `make fe-test` (`tsc` clean + vitest green).
- No live BFL/LLM/MCP network calls in the test suite — inject the fake `imagegen.Provider` (`fakeProvider` in `fanart_generate_test.go`); the studio provider is built but never invoked.
- English only. Loom design tokens (`--color-*`, `--radius-ui`, `--font-*` in `ui/src/index.css`) and self-hosted Anthropic fonts. No AI vendor branding/wordmark in anonymous-visible copy. Presence/absence gating — no lock icons.
- Cover-art model allowlist (exact strings — they become BFL URL path segments): `flux-2-klein-4b`, `flux-2-flex`, `flux-2-pro`. Empty request model → fall back to `cfg.BFLModel`.
- Dimensions: 1024×1024 PNG. Seed: random per request, recorded server-side, never shown.
- Server-only fields (never serialized to any client): image path, prompt, model, seed, error.
- All Read/Edit/Write target the worktree at `/Users/jan/localgit/music/.claude/worktrees/feat+phase-10-studio-coverart/`.
- Pre-launch squash-migrations rule: new SQL is folded into `0001_init.sql`; do NOT add a new `NNNN_` migration file.

---

## File Structure

- Create `backend/internal/library/studio_coverart.go` — `StudioCoverArt` type + `CreateStudioCoverArt` / `GetStudioCoverArt`.
- Create `backend/internal/library/studio_coverart_test.go` — repo + migration tests.
- Modify `backend/internal/store/migrations/0001_init.sql` — add `studio_coverart` table.
- Create `backend/internal/httpapi/studio_coverart.go` — `postStudioCoverArt` / `getStudioCoverArt` on `songHandlers` + model allowlist.
- Create `backend/internal/httpapi/studio_coverart_test.go` — dedicated test harness + handler tests.
- Modify `backend/internal/httpapi/server.go` — register the two routes.
- Modify `ui/src/api.ts` — `COVER_ART_MODELS`, `generateStudioCoverArt`, `studioCoverArtUrl`.
- Modify `ui/src/StudioPage.tsx` — editable cover-art prompt + exported `CoverArtCard`.
- Modify `ui/src/App.tsx` — pass `imageGenEnabled` into `<StudioPage />`.
- Modify `ui/src/Studio.test.tsx` — `CoverArtCard` tests.

---

## Task 1: Persistence — `studio_coverart` table + repo

**Files:**
- Modify: `backend/internal/store/migrations/0001_init.sql` (after the `idx_fanart_genre` index)
- Create: `backend/internal/library/studio_coverart.go`
- Test: `backend/internal/library/studio_coverart_test.go`

**Interfaces:**
- Consumes: existing `Repo` (`backend/internal/library/songs.go:43`, `type Repo struct{ db *sql.DB }`), `NewID()` (`library/id.go`), `nullIfEmpty` (`library/fanart.go:41`), test helper `newRepo(t)` (`library/songs_test.go:10`).
- Produces:
  - `type StudioCoverArt struct { ID, Status string; Width, Height int; ImagePath, Prompt, Model, ErrorMsg string; Seed *int64 }`
  - `func (r *Repo) CreateStudioCoverArt(ctx context.Context, id, imagePath, prompt, model string, seed *int64, width, height int) error`
  - `func (r *Repo) GetStudioCoverArt(ctx context.Context, id string) (*StudioCoverArt, error)` — `(nil, nil)` when absent.

- [ ] **Step 1: Add the migration table.** In `backend/internal/store/migrations/0001_init.sql`, immediately after the line `CREATE INDEX idx_fanart_genre ON fanart(genre_id);`, add:

```sql

CREATE TABLE studio_coverart (
    id         TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    prompt     TEXT,                       -- server-only, never served to clients
    model      TEXT,                       -- server-only, never served to clients
    seed       INTEGER,                    -- server-only
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
    error      TEXT,                       -- server-only
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write the failing repo test.** Create `backend/internal/library/studio_coverart_test.go`:

```go
package library

import (
	"context"
	"testing"
)

func TestStudioCoverArt_createGetAndScrub(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	seed := int64(1234)
	if err := r.CreateStudioCoverArt(ctx, "c1", "coverart/c1.png", "a neon album cover", "flux-2-pro", &seed, 1024, 1024); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := r.GetStudioCoverArt(ctx, "c1")
	if err != nil || got == nil {
		t.Fatalf("get: %v (row %v)", err, got)
	}
	if got.Status != "ready" || got.Width != 1024 || got.Height != 1024 {
		t.Fatalf("unexpected row: %#v", got)
	}
	if got.ImagePath != "coverart/c1.png" || got.Prompt != "a neon album cover" || got.Model != "flux-2-pro" {
		t.Fatalf("server-only fields not stored: %#v", got)
	}
	if got.Seed == nil || *got.Seed != 1234 {
		t.Fatalf("seed not recorded: %#v", got.Seed)
	}
}

func TestStudioCoverArt_getMissingReturnsNil(t *testing.T) {
	r := newRepo(t)
	got, err := r.GetStudioCoverArt(context.Background(), "nope")
	if err != nil || got != nil {
		t.Fatalf("expected (nil,nil), got (%v,%v)", got, err)
	}
}

func TestMigration_studioCoverartStatusCheck(t *testing.T) {
	r := newRepo(t)
	if _, err := r.db.ExecContext(context.Background(),
		`INSERT INTO studio_coverart(id,image_path,status) VALUES('x','coverart/x.png','bogus')`); err == nil {
		t.Fatal("expected status CHECK to reject 'bogus'")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `cd backend && go test ./internal/library/ -run TestStudioCoverArt -v`
Expected: FAIL — `r.CreateStudioCoverArt undefined` (compile error).

- [ ] **Step 4: Implement the repo.** Create `backend/internal/library/studio_coverart.go`:

```go
package library

import (
	"context"
	"database/sql"
	"errors"
)

// StudioCoverArt is a persisted Studio cover-art image. Image path, prompt,
// model, seed, and error are server-only and never serialized to clients.
type StudioCoverArt struct {
	ID     string
	Status string
	Width  int
	Height int

	ImagePath string
	Prompt    string
	Model     string
	ErrorMsg  string
	Seed      *int64
}

const studioCoverArtSelect = `SELECT id, status, width, height, image_path,
	COALESCE(prompt,''), COALESCE(model,''), COALESCE(error,''), seed FROM studio_coverart`

// CreateStudioCoverArt inserts a ready cover-art row, recording the server-only
// prompt/model/seed. Studio cover art is generated synchronously, so rows are
// written only on success and always in the 'ready' state.
func (r *Repo) CreateStudioCoverArt(ctx context.Context, id, imagePath, prompt, model string, seed *int64, width, height int) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO studio_coverart(id,image_path,prompt,model,seed,width,height,status)
		 VALUES(?,?,?,?,?,?,?, 'ready')`,
		id, imagePath, nullIfEmpty(prompt), nullIfEmpty(model), seed, width, height)
	return err
}

// GetStudioCoverArt returns the row, or (nil, nil) when absent.
func (r *Repo) GetStudioCoverArt(ctx context.Context, id string) (*StudioCoverArt, error) {
	c, err := scanStudioCoverArt(r.db.QueryRowContext(ctx, studioCoverArtSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return c, err
}

func scanStudioCoverArt(s interface{ Scan(...any) error }) (*StudioCoverArt, error) {
	var c StudioCoverArt
	var seed sql.NullInt64
	if err := s.Scan(&c.ID, &c.Status, &c.Width, &c.Height, &c.ImagePath,
		&c.Prompt, &c.Model, &c.ErrorMsg, &seed); err != nil {
		return nil, err
	}
	if seed.Valid {
		c.Seed = &seed.Int64
	}
	return &c, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd backend && go test ./internal/library/ -run 'TestStudioCoverArt|TestMigration_studioCoverart' -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit.**

```bash
git add backend/internal/store/migrations/0001_init.sql backend/internal/library/studio_coverart.go backend/internal/library/studio_coverart_test.go
git commit -m "feat(studio): persist cover art in a dedicated studio_coverart table"
```

---

## Task 2: Backend handlers + model allowlist + route wiring

**Files:**
- Create: `backend/internal/httpapi/studio_coverart.go`
- Modify: `backend/internal/httpapi/server.go` (register routes after the fanart routes, ~line 139)
- Test: `backend/internal/httpapi/studio_coverart_test.go`

**Interfaces:**
- Consumes: `songHandlers` (fields `cfg config.Config`, `repo *library.Repo`, `media *media.Store`, `imageGen imagegen.Provider`, `bflModel string`); `identify(cfg, r).Authenticated`; `httpError`, `writeJSON` (`server.go`/`songs.go`); `randomSeed()` (`fanart_generate.go`); `writeBytes(store, relPath, b)` (`imageserve.go`); `serveSizedImage(w, r, store, relPath)` (`imageserve.go:31`); `imageutil.Probe(io.Reader) (w, h int, ext string, err error)`; `imagegen.MaxPromptRunes` (=4000), `imagegen.GenerateRequest`; `library.NewID`; `CreateStudioCoverArt`/`GetStudioCoverArt` (Task 1).
- Produces: `POST /api/studio/coverart` → `{ "id": string, "status": "ready", "width": int, "height": int }`; `GET /api/studio/coverart/{id}` → PNG bytes.

- [ ] **Step 1: Write the failing handler tests.** Create `backend/internal/httpapi/studio_coverart_test.go`:

```go
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

type studioCoverTS struct {
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

// newStudioCoverServer builds an authed (dev) and anonymous (oidc) handler over a
// shared store. gen != nil sets the BFL key (ImageGenEnabled); studioConfigured
// sets the chat+Tavily keys (StudioEnabled). The real studio provider is built
// but never invoked by these tests (construction does no network I/O).
func newStudioCoverServer(t *testing.T, gen imagegen.Provider, studioConfigured bool) *studioCoverTS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: 50, BFLModel: "flux-2-klein-4b",
			BFLPollTimeout: 1_000_000_000,
		}
		if gen != nil {
			cfg.BFLAPIKey = "test-key"
		}
		if studioConfigured {
			cfg.ChatAPIKey = "chat-key"
			cfg.TavilyAPIKey = "tavily-key"
		}
		return NewWithProvider(cfg, st, spa, gen, nil)
	}
	return &studioCoverTS{
		dev:  mk(config.AuthModeDev),
		anon: mk(config.AuthModeOIDC),
		repo: library.NewRepo(st.DB()),
	}
}

func (ts *studioCoverTS) postCover(t *testing.T, h http.Handler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/studio/coverart", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func okProvider(t *testing.T) fakeProvider {
	return fakeProvider{result: imagegen.GenerateResult{Bytes: pngBytes(t, 1024, 1024), MIMEType: "image/png", Extension: "png"}}
}

func TestStudioCoverArt_generatesAndPersists(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "a neon skyline album cover", "model": "flux-2-pro"})
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "neon skyline") {
		t.Fatalf("response leaked prompt: %s", rec.Body)
	}
	var out struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Status != "ready" || out.ID == "" {
		t.Fatalf("bad response %s (err %v)", rec.Body, err)
	}
	row, err := ts.repo.GetStudioCoverArt(context.Background(), out.ID)
	if err != nil || row == nil {
		t.Fatalf("row not persisted: %v", err)
	}
	if row.Prompt != "a neon skyline album cover" || row.Model != "flux-2-pro" || row.Seed == nil {
		t.Fatalf("server-only fields not recorded: %#v", row)
	}
}

func TestStudioCoverArt_serveReturnsImageAndAnonForbidden(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-klein-4b"})
	var out struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)

	got := httptest.NewRecorder()
	ts.dev.ServeHTTP(got, httptest.NewRequest("GET", "/api/studio/coverart/"+out.ID, nil))
	if got.Code != http.StatusOK || got.Body.Len() == 0 {
		t.Fatalf("serve: code=%d len=%d", got.Code, got.Body.Len())
	}
	anon := httptest.NewRecorder()
	ts.anon.ServeHTTP(anon, httptest.NewRequest("GET", "/api/studio/coverart/"+out.ID, nil))
	if anon.Code != http.StatusForbidden {
		t.Fatalf("anon serve code = %d, want 403", anon.Code)
	}
}

func TestStudioCoverArt_disabledWhenNoImageGen(t *testing.T) {
	ts := newStudioCoverServer(t, nil, true) // studio configured, image gen not
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestStudioCoverArt_disabledWhenStudioOff(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), false) // image gen on, studio off
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestStudioCoverArt_rejectsUnknownModel(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "evil/../path"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestStudioCoverArt_anonymousForbidden(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.anon, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestStudioCoverArt_generationErrorIs502(t *testing.T) {
	ts := newStudioCoverServer(t, fakeProvider{err: errors.New("BFL blocked the prompt (request moderated)")}, true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("code = %d, want 502", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "moderated") {
		t.Fatalf("leaked upstream detail: %s", rec.Body)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `cd backend && go test ./internal/httpapi/ -run TestStudioCoverArt -v`
Expected: FAIL — routes 404 for all (handlers/routes not defined yet), so the generate/serve assertions fail.

- [ ] **Step 3: Implement the handlers.** Create `backend/internal/httpapi/studio_coverart.go`:

```go
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

// coverArtModels is the allowlist of BFL models the Studio cover-art picker may
// request. The value becomes a URL path segment in the BFL call, so only known
// models are accepted; anything else is rejected before any upstream request.
var coverArtModels = map[string]bool{
	"flux-2-klein-4b": true,
	"flux-2-flex":     true,
	"flux-2-pro":      true,
}

// coverArtSize is the square album dimension (matches the prompt's
// "square album composition").
const coverArtSize = 1024

// postStudioCoverArt generates a cover-art image from a prompt synchronously,
// persists it (accumulating), and returns its id. Authed-only, both-keys gate:
// Studio configured (chat+Tavily) AND image generation configured (BFL).
func (h *songHandlers) postStudioCoverArt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if !h.cfg.StudioEnabled() || !h.cfg.ImageGenEnabled() || h.imageGen == nil {
		httpError(w, http.StatusNotFound, "studio cover art is not configured")
		return
	}
	var req struct {
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Prompt == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if len([]rune(req.Prompt)) > imagegen.MaxPromptRunes {
		httpError(w, http.StatusBadRequest, "prompt is too long")
		return
	}
	model := req.Model
	if model == "" {
		model = h.cfg.BFLModel
	} else if !coverArtModels[model] {
		httpError(w, http.StatusBadRequest, "unknown model")
		return
	}

	seed := randomSeed()
	id := library.NewID()

	genCtx, cancel := context.WithTimeout(r.Context(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()
	res, err := h.imageGen.Generate(genCtx, imagegen.GenerateRequest{
		Prompt: req.Prompt, Width: coverArtSize, Height: coverArtSize,
		OutputFormat: "png", Seed: &seed, Model: model,
	})
	if err != nil {
		// Never leak the prompt or upstream detail to the client.
		httpError(w, http.StatusBadGateway, "cover art generation failed")
		return
	}
	relPath := "coverart/" + id + ".png"
	if err := writeBytes(h.media, relPath, res.Bytes); err != nil {
		httpError(w, http.StatusInternalServerError, "store generated image")
		return
	}
	width, height := res.Width, res.Height
	if pw, ph, _, perr := imageutil.Probe(bytes.NewReader(res.Bytes)); perr == nil {
		width, height = pw, ph
	}
	if err := h.repo.CreateStudioCoverArt(r.Context(), id, relPath, req.Prompt, model, &seed, width, height); err != nil {
		httpError(w, http.StatusInternalServerError, "record generated image")
		return
	}
	writeJSON(w, map[string]any{"id": id, "status": "ready", "width": width, "height": height})
}

// getStudioCoverArt serves a generated cover-art image. Authed-only, unlike the
// public fanart backgrounds.
func (h *songHandlers) getStudioCoverArt(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	c, err := h.repo.GetStudioCoverArt(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get cover art")
		return
	}
	if c == nil || c.Status != "ready" || c.ImagePath == "" {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	serveSizedImage(w, r, h.media, c.ImagePath)
}
```

- [ ] **Step 4: Register the routes.** In `backend/internal/httpapi/server.go`, immediately after the line `mux.HandleFunc("POST /api/fanart/generate", h.postFanartGenerate)`, add:

```go
				mux.HandleFunc("POST /api/studio/coverart", h.postStudioCoverArt)
				mux.HandleFunc("GET /api/studio/coverart/{id}", h.getStudioCoverArt)
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd backend && go test ./internal/httpapi/ -run TestStudioCoverArt -v`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full backend suite.**

Run: `cd backend && go test ./...`
Expected: PASS (ignore a flaky `TestHomeFeed_recentNewestFirstWithLimit` if it appears — re-run to confirm it's the known flake).

- [ ] **Step 7: Commit.**

```bash
git add backend/internal/httpapi/studio_coverart.go backend/internal/httpapi/studio_coverart_test.go backend/internal/httpapi/server.go
git commit -m "feat(studio): synchronous cover-art generation endpoint (model picker, gated)"
```

---

## Task 3: Frontend API client

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces:
  - `export const COVER_ART_MODELS: { id: string; label: string }[]`
  - `export async function generateStudioCoverArt(prompt: string, model: string): Promise<{ id: string; status: string; width: number; height: number }>`
  - `export function studioCoverArtUrl(id: string): string`

- [ ] **Step 1: Add the client code.** Append to `ui/src/api.ts` (near the other studio functions):

```ts
export const COVER_ART_MODELS: { id: string; label: string }[] = [
  { id: "flux-2-klein-4b", label: "Fast · flux-2-klein-4b" },
  { id: "flux-2-flex", label: "Balanced (typography) · flux-2-flex" },
  { id: "flux-2-pro", label: "Best quality · flux-2-pro" },
];

export async function generateStudioCoverArt(
  prompt: string,
  model: string,
): Promise<{ id: string; status: string; width: number; height: number }> {
  const r = await fetch("/api/studio/coverart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  if (!r.ok) throw new Error(`cover art failed (${r.status})`);
  return r.json();
}

export function studioCoverArtUrl(id: string): string {
  return `/api/studio/coverart/${id}`;
}
```

- [ ] **Step 2: Typecheck.**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add ui/src/api.ts
git commit -m "feat(studio): cover-art API client (models, generate, url)"
```

---

## Task 4: Frontend — editable prompt, `CoverArtCard`, App wiring

**Files:**
- Modify: `ui/src/StudioPage.tsx`
- Modify: `ui/src/App.tsx`
- Test: `ui/src/Studio.test.tsx`

**Interfaces:**
- Consumes: `COVER_ART_MODELS`, `generateStudioCoverArt`, `studioCoverArtUrl` (Task 3); existing `Spinner` and `ResultCard` (`StudioPage.tsx`); `Icon` (`ui/src/Icon.tsx`, glyph `download`); `Session.imageGenEnabled` (`api.ts`).
- Produces: `export function CoverArtCard({ prompt }: { prompt: string })`; `StudioPage` now accepts `{ imageGenEnabled?: boolean }`.

- [ ] **Step 1: Write the failing `CoverArtCard` test.** In `ui/src/Studio.test.tsx`, add the import and a new describe block:

Change the import line to include `CoverArtCard`:
```tsx
import { StudioPage, ResultCard, CoverArtCard } from "./StudioPage";
```

Add at the end of the file:
```tsx
describe("CoverArtCard", () => {
  it("renders the model picker and a generate action", () => {
    const html = renderToStaticMarkup(<CoverArtCard prompt="a moody album cover" />);
    expect(html).toContain("Generate cover art");
    expect(html).toContain("flux-2-pro");
    expect(html).toContain("flux-2-klein-4b");
    expect(html).toContain('aria-label="Cover art model"');
  });
});

describe("StudioPage cover-art gating", () => {
  it("renders without a cover-art card in the idle state regardless of imageGenEnabled", () => {
    const html = renderToStaticMarkup(<StudioPage imageGenEnabled />);
    // No result yet, so no cover-art card is shown, but the page still renders.
    expect(html).toContain("Turn a song into a Suno prompt");
    expect(html).not.toContain("Generate cover art");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `cd ui && npx vitest run src/Studio.test.tsx`
Expected: FAIL — `CoverArtCard` is not exported.

- [ ] **Step 3: Add `CoverArtCard` and make the prompt editable.** In `ui/src/StudioPage.tsx`:

Update the imports at the top:
```tsx
import { useState } from "react";
import { studioGenerate, studioRefine, generateStudioCoverArt, studioCoverArtUrl, COVER_ART_MODELS, type StudioProgress, type StudioResult } from "./api";
import { copyText } from "./share";
import { Icon } from "./Icon";
```

Add this component just above `StudioPage` (after `ResultCard`):
```tsx
// CoverArtCard generates a real album cover from the (editable) cover-art prompt
// using the configured image generator. It picks a model, shows the image inline,
// and offers a download. Ephemeral in the UI: state resets when a new song is
// generated (the parent remounts it via key).
export function CoverArtCard({ prompt }: { prompt: string }) {
  const [model, setModel] = useState(COVER_ART_MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<{ id: string } | null>(null);
  const [error, setError] = useState("");

  const generate = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await generateStudioCoverArt(p, model);
      setImage({ id: res.id });
    } catch (e) {
      setError((e as Error).message || "Cover art generation failed");
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || prompt.trim() === "";
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.6rem" }}>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Cover art model"
          disabled={busy}
          style={{
            background: "var(--color-panel)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-ui)",
            padding: "0.5rem 0.6rem",
            color: "var(--color-ink)",
            fontFamily: "var(--font-sans)",
            fontSize: "0.85rem",
            outline: "none",
          }}
        >
          {COVER_ART_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button
          onClick={generate}
          disabled={disabled}
          style={{
            background: "var(--color-accent-strong)",
            color: "#1a0f0a",
            fontWeight: 600,
            fontSize: "0.85rem",
            border: "none",
            borderRadius: "var(--radius-ui)",
            padding: "0.5rem 0.9rem",
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "Generating…" : image ? "Regenerate" : "Generate cover art"}
        </button>
      </div>
      {busy && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--color-ink)", fontSize: "0.9rem" }}>
          <Spinner />
          <span>Generating cover art…</span>
        </div>
      )}
      {error && !busy && (
        <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "0.85rem", margin: "0.4rem 0 0" }}>{error}</p>
      )}
      {image && !busy && (
        <div style={{ marginTop: "0.4rem" }}>
          <img
            src={studioCoverArtUrl(image.id)}
            alt="Generated cover art"
            style={{ width: "100%", maxWidth: 360, aspectRatio: "1 / 1", objectFit: "cover", borderRadius: "var(--radius-ui)", border: "1px solid var(--color-border)", display: "block" }}
          />
          <a
            href={studioCoverArtUrl(image.id)}
            download="cover.png"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginTop: "0.6rem", fontSize: "0.82rem", color: "var(--color-ink)", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
          >
            <Icon name="download" size="14px" /> Download
          </a>
        </div>
      )}
    </div>
  );
}
```

Change the `StudioPage` signature to accept the prop:
```tsx
export function StudioPage({ imageGenEnabled = false }: { imageGenEnabled?: boolean }) {
```

Replace the read-only cover-art `ResultCard` at the bottom of the results block:
```tsx
          <ResultCard name="Cover-art prompt" note="→ image generator (coming later)" text={result.coverArtPrompt} />
```
with an editable card followed by the (gated) generator:
```tsx
          <ResultCard
            name="Cover-art prompt"
            note="→ image generator · editable"
            text={result.coverArtPrompt}
            onChange={(value) => setResult({ ...result, coverArtPrompt: value })}
          />
          {imageGenEnabled && <CoverArtCard key={generatedRef} prompt={result.coverArtPrompt} />}
```

- [ ] **Step 4: Wire the prop in `App.tsx`.** In `ui/src/App.tsx`, find the Studio route render (`authed && session?.studioEnabled ? <StudioPage /> : ...`) and pass the flag:
```tsx
authed && session?.studioEnabled ? <StudioPage imageGenEnabled={!!session?.imageGenEnabled} /> : (
```
(Keep the rest of that ternary unchanged.)

- [ ] **Step 5: Run the frontend test to verify it passes.**

Run: `cd ui && npx vitest run src/Studio.test.tsx`
Expected: PASS (existing + new cases).

- [ ] **Step 6: Typecheck + full frontend suite.**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit.**

```bash
git add ui/src/StudioPage.tsx ui/src/App.tsx ui/src/Studio.test.tsx
git commit -m "feat(studio): editable cover-art prompt + cover-art generator card"
```

---

## Task 5: End-to-end verification (Playwright) + final checks

**Files:** none (verification only). Uses the running dev app.

- [ ] **Step 1: Full backend + frontend gates.**

Run: `cd backend && go test ./... && cd ../ui && npx tsc --noEmit && npx vitest run`
Expected: green (ignore the known-flaky `TestHomeFeed_recentNewestFirstWithLimit`).

- [ ] **Step 2: Run the app.** Follow the project's `run` skill / docker-dev workflow to start the app with an authenticated session. For the "both keys present" pass, set the BFL, chat, and Tavily keys (or point image gen at a stubbed provider that returns a small PNG so no live credits are spent).

- [ ] **Step 3: Playwright — gating (invisible without both keys).** With image gen disabled (no BFL key) but Studio enabled, navigate to `/studio`, generate a prompt for a known song, and assert the "Generate cover art" control is **not present**:
  - `browser_navigate` to the app, authenticate, open Studio.
  - `browser_snapshot`; assert no element with text "Generate cover art".

- [ ] **Step 4: Playwright — generate and display (both keys).** With both keys present:
  - Open `/studio`, enter a song reference, Generate; wait for the results.
  - Assert the "Generate cover art" button and the "Cover art model" `<select>` are present.
  - Click "Generate cover art"; `browser_wait_for` the `img[alt="Generated cover art"]` to appear.
  - Assert the Download link (`a[download="cover.png"]`) is present and its `href` starts with `/api/studio/coverart/`.

- [ ] **Step 5: Commit any test scaffolding** (if a Playwright spec was added to the repo; otherwise skip). Record the manual e2e result in the PR description.

---

## Self-Review (completed by plan author)

- **Spec coverage:** sync generation (Task 2), persistence/accumulation (Tasks 1–2), 1024² PNG (Task 2 `coverArtSize`), editable prompt (Task 4), model picker + allowlist (Tasks 2–4), seed random+hidden (Task 2 records seed; UI never surfaces it), both-keys gate (Task 2 handler + Task 4 UI), dedicated table (Task 1), reuse of `serveSizedImage`/`writeBytes`/`imageutil.Probe`/fake provider (Task 2), view+download (Task 4), tests + e2e (Tasks 1–5). All spec sections map to a task.
- **Placeholders:** none — every code step is complete.
- **Type consistency:** `CreateStudioCoverArt`/`GetStudioCoverArt` signatures, the `StudioCoverArt` fields, the `{id,status,width,height}` response shape, `COVER_ART_MODELS`/`generateStudioCoverArt`/`studioCoverArtUrl`, and the `CoverArtCard`/`StudioPage` props are used identically across tasks.
