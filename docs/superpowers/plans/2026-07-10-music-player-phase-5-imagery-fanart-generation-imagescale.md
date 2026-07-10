# Music Player — Phase 5: Imagery, Fanart, AI Generation & Image Sizing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated users upload, AI-generate, and assign photographic fanart (genre backgrounds + featured hero), auto-sample a per-genre accent colour from the active background, and serve sized image variants — while anonymous visitors only ever see finished art.

**Architecture:** Two verbatim ports from the sibling `loom` repo (`imagegen`/BFL, `imagescale`) plus new `library/fanart.go` repo methods over the existing `fanart` table (columns folded into `0001_init.sql`). HTTP handlers gate every write to the authenticated role and **never serialize `prompt`/`model`/generation-error text to any client**. AI generation is async: an endpoint creates a `status='generating'` row, a goroutine drives BFL submit→poll→download through an injected `imagegen.Provider` (a fake in tests, a real `BFLClient` in prod), and the client polls `GET /api/fanart/{id}?meta=1`. Generation is only wired when `BACKEND_BFL_API_KEY` is set; otherwise the editor degrades to Upload-only. A minimal genre list+detail SPA surface hosts the editor modal.

**Tech Stack:** Go 1.25 (`CGO_ENABLED=0`, stdlib `net/http` method routing), pure-Go SQLite `ncruces/go-sqlite3`, `golang.org/x/image` (for `imagescale`), Vite + React 19 + TS, Vitest, Playwright MCP for validation.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from AGENTS.md and the Phase 5 brief:

- Module `github.com/trick77/music`, Go 1.25, `CGO_ENABLED=0`. All Go commands run from `backend/`.
- Pure-Go SQLite `ncruces/go-sqlite3` v0.23.3 (never `mattn/go-sqlite3`). One SQLite file.
- HTTP: stdlib `net/http` (Go 1.22 method routing), no framework.
- Frontend: Vite + React 19 + TS + Tailwind v4, built into `backend/web/dist`, embedded by Go. All `ui/` commands run from `ui/`.
- **TDD:** failing test first, then minimal impl. Conventional commits. Commit after every green task.
- English only in docs/code/comments. `.yaml`, never `.yml`.
- **No AI branding or wordmark in any UI copy.** The prompt box / "Generate" / any AI reference is an owner-only, authenticated tool. **Anonymous visitors must never receive a prompt, a "generate" control, or any AI reference — not in the DOM and not in any JSON response body.**
- Every write endpoint is role-gated to authenticated (`identify(h.cfg, r).Authenticated`); anonymous can only read/view/download.
- Media/image file access stays sandboxed under the media root via `media.Store` (rejects `..`, absolute, symlink escape). Uploads validated (MIME/extension/size).
- Secrets (BFL key) via env only — never committed.
- **Migrations are squashed pre-launch:** fold every new `fanart`/`genres` column into `backend/internal/store/migrations/0001_init.sql`. Do NOT add `0002_*.sql`.
- Design tokens = loom `--*` CSS variables + self-hosted Anthropic fonts. Reuse the existing `Icon`/`Menu` components in `ui/src/`.
- Worktree: `/Users/jan/localgit/music/.claude/worktrees/feat+phase-5-imagery-fanart-generation-imagescale`, branch `feat/phase-5-imagery-fanart-generation-imagescale`. Never touch the main checkout at `/Users/jan/localgit/music`.

**Sizes used app-wide (define once in `httpapi`):** `thumb` = 160 px, `card` = 480 px, `hero` = 1600 px (longest side). Generated hero/background images request landscape **1344×768** (≤ 4 MP, 16-aligned).

---

## File Structure

**Backend — new files:**
- `backend/internal/imagegen/model.go`, `bfl.go`, `model_test.go`, `bfl_test.go` — verbatim port from loom (no `tool.go`).
- `backend/internal/imagescale/imagescale.go`, `imagescale_test.go` — verbatim port from loom.
- `backend/internal/library/fanart.go`, `fanart_test.go` — fanart + genre-imagery repo layer.
- `backend/internal/httpapi/fanart.go`, `fanart_test.go` — upload, serve (sized), meta, assign.
- `backend/internal/httpapi/fanart_generate.go`, `fanart_generate_test.go` — async generation + Provider injection.
- `backend/internal/httpapi/genres.go`, `genres_test.go` — `PATCH /api/genres/{id}`, extended genre read.
- `backend/internal/httpapi/imageserve.go`, `imageserve_test.go` — shared sized-image serving with on-disk cache.

**Backend — modified:**
- `backend/internal/config/config.go`, `config_test.go` — BFL settings + `ImageGenEnabled()`.
- `backend/internal/imageutil/imageutil.go`, `imageutil_test.go` — `AverageColor`.
- `backend/internal/store/migrations/0001_init.sql` — fold new columns.
- `backend/internal/library/browse.go` — `GenreSummary.AccentColor`; scan it in `GetGenre`.
- `backend/internal/httpapi/coverupload.go` — extract shared `bufferProbeImage` helper.
- `backend/internal/httpapi/covers.go` — `getCover` honours `?size=`.
- `backend/internal/httpapi/server.go` — build `BFLClient` when enabled; register routes.
- `backend/go.mod`, `go.sum` — add `golang.org/x/image`.
- `.env.example` — add BFL vars (verify against §13).

**Frontend — new files:**
- `ui/src/fanart.ts`, `fanart.test.ts` — `fanartUrl`, size helper, fallback initial.
- `ui/src/GenreDetail.tsx` — minimal genre page (background + songs + Edit).
- `ui/src/GenreEditor.tsx`, `GenreEditor.test.tsx` — the editor modal + no-AI-in-UI test.

**Frontend — modified:**
- `ui/src/api.ts` — genre/fanart types + calls; `Session.imageGenEnabled`.
- `ui/src/router.ts`, `router.test.ts` — `genres` + `genre` routes.
- `ui/src/App.tsx` — route wiring; pass session flag.
- `ui/src/Library.tsx` — a "Genres" tab listing genres (links to `/genre/{id}`).

---

## Task 1: Config — BFL settings & `ImageGenEnabled()`

**Files:**
- Modify: `backend/internal/config/config.go`
- Test: `backend/internal/config/config_test.go`

**Interfaces:**
- Produces: `Config.BFLBaseURL string`, `Config.BFLAPIKey string`, `Config.BFLModel string`, `Config.BFLPollTimeout time.Duration`, `func (c Config) ImageGenEnabled() bool`.

- [ ] **Step 1: Write the failing tests** — append to `config_test.go`. (Existing tests set `BACKEND_SESSION_SECRET`; mirror that.)

```go
func TestLoad_BFLDefaults(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BFLBaseURL != "https://api.bfl.ai/v1" || cfg.BFLModel != "flux-2-klein-4b" {
		t.Fatalf("BFL defaults = %q / %q", cfg.BFLBaseURL, cfg.BFLModel)
	}
	if cfg.BFLPollTimeout != time.Minute {
		t.Fatalf("BFLPollTimeout = %s, want 1m0s", cfg.BFLPollTimeout)
	}
	if cfg.ImageGenEnabled() {
		t.Fatal("ImageGenEnabled must be false with no API key")
	}
}

func TestLoad_BFLEnabledByAPIKey(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_BFL_API_KEY", "bfl-test")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.ImageGenEnabled() || cfg.BFLAPIKey != "bfl-test" {
		t.Fatalf("ImageGenEnabled/APIKey = %v / %q", cfg.ImageGenEnabled(), cfg.BFLAPIKey)
	}
}

func TestLoad_BFLPollTimeoutOverrideAndReject(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_BFL_POLL_TIMEOUT", "7m")
	cfg, err := Load()
	if err != nil || cfg.BFLPollTimeout != 7*time.Minute {
		t.Fatalf("override: %v / %s", err, cfg.BFLPollTimeout)
	}
	t.Setenv("BACKEND_BFL_POLL_TIMEOUT", "soon")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_BFL_POLL_TIMEOUT") {
		t.Fatalf("reject invalid: %v", err)
	}
}
```

Add imports `"strings"`, `"time"` to the test file if missing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/config/ 2>&1 | tail`
Expected: FAIL — `cfg.BFLBaseURL` undefined.

- [ ] **Step 3: Implement** — in `config.go`: add fields to `Config`, a `const defaultBFLPollTimeout = 1 * time.Minute`, `import "time"`, parse in `Load()` (before the final `return`), and the method.

```go
// in the Config struct:
	BFLBaseURL     string
	BFLAPIKey      string
	BFLModel       string
	BFLPollTimeout time.Duration
```

```go
// in Load(), after cfg is built and validated, before `return cfg, nil`:
	cfg.BFLBaseURL = env("BACKEND_BFL_BASE_URL", "https://api.bfl.ai/v1")
	cfg.BFLAPIKey = env("BACKEND_BFL_API_KEY", "")
	cfg.BFLModel = env("BACKEND_BFL_MODEL", "flux-2-klein-4b")
	pollTimeout, err := time.ParseDuration(env("BACKEND_BFL_POLL_TIMEOUT", defaultBFLPollTimeout.String()))
	if err != nil || pollTimeout <= 0 {
		return Config{}, fmt.Errorf("BACKEND_BFL_POLL_TIMEOUT must be a duration greater than 0")
	}
	cfg.BFLPollTimeout = pollTimeout
	if cfg.BFLAPIKey != "" && cfg.BFLBaseURL == "" {
		return Config{}, fmt.Errorf("BACKEND_BFL_BASE_URL is required when BACKEND_BFL_API_KEY is set")
	}
```

```go
// ImageGenEnabled reports whether AI image generation is configured (a BFL key is set).
func (c Config) ImageGenEnabled() bool { return c.BFLAPIKey != "" }
```

Add `const defaultBFLPollTimeout = 1 * time.Minute` near the top and ensure `time` is imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/config/`
Expected: PASS (ok).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/config/
git commit -m "feat(config): BFL image-generation settings and ImageGenEnabled()"
```

---

## Task 2: Port loom's `imagegen` (BFL) package verbatim

**Files:**
- Create: `backend/internal/imagegen/model.go`, `backend/internal/imagegen/bfl.go`, `backend/internal/imagegen/model_test.go`, `backend/internal/imagegen/bfl_test.go`

**Interfaces:**
- Produces: `imagegen.Provider` (`Generate(context.Context, GenerateRequest) (GenerateResult, error)`), `imagegen.GenerateRequest`, `imagegen.GenerateResult`, `imagegen.BFLConfig`, `imagegen.NewBFLClient(BFLConfig) *BFLClient`.

- [ ] **Step 1: Copy the four files verbatim** from loom (they are self-contained, package `imagegen`, no external music deps). Do NOT copy `tool.go`/`tool_test.go` (loom LLM-tool wiring, not needed here).

```bash
cp /Users/jan/localgit/loom/backend/internal/imagegen/model.go      backend/internal/imagegen/model.go
cp /Users/jan/localgit/loom/backend/internal/imagegen/bfl.go        backend/internal/imagegen/bfl.go
cp /Users/jan/localgit/loom/backend/internal/imagegen/model_test.go backend/internal/imagegen/model_test.go
cp /Users/jan/localgit/loom/backend/internal/imagegen/bfl_test.go   backend/internal/imagegen/bfl_test.go
```

- [ ] **Step 2: Run the ported tests**

Run: `cd backend && go test ./internal/imagegen/ 2>&1 | tail`
Expected: PASS — the tests use `httptest`, no network, no extra deps.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/imagegen/
git commit -m "feat(imagegen): port loom BFL image-generation client verbatim"
```

---

## Task 3: Port loom's `imagescale` package verbatim (+ `golang.org/x/image`)

**Files:**
- Create: `backend/internal/imagescale/imagescale.go`, `backend/internal/imagescale/imagescale_test.go`
- Modify: `backend/go.mod`, `backend/go.sum`

**Interfaces:**
- Produces: `imagescale.Thumbnail(data []byte, maxDimension int) ([]byte, error)`, `imagescale.DownscaleForModel`, `imagescale.MaxDimension`.

- [ ] **Step 1: Copy the two files verbatim** from loom.

```bash
cp /Users/jan/localgit/loom/backend/internal/imagescale/imagescale.go      backend/internal/imagescale/imagescale.go
cp /Users/jan/localgit/loom/backend/internal/imagescale/imagescale_test.go backend/internal/imagescale/imagescale_test.go
```

- [ ] **Step 2: Add the dependency** (`golang.org/x/image@v0.43.0` is already in the module cache — matches loom).

Run: `cd backend && go get golang.org/x/image@v0.43.0 && go mod tidy`

- [ ] **Step 3: Run the ported tests**

Run: `cd backend && go test ./internal/imagescale/ 2>&1 | tail`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/imagescale/ backend/go.mod backend/go.sum
git commit -m "feat(imagescale): port loom image-scaling package verbatim"
```

---

## Task 4: `imageutil.AverageColor` — accent sampling

**Files:**
- Modify: `backend/internal/imageutil/imageutil.go`
- Test: `backend/internal/imageutil/imageutil_test.go`

**Interfaces:**
- Produces: `func AverageColor(r io.Reader) (string, error)` — returns a lowercase `#rrggbb` hex string of the mean colour, or `ErrUnsupported` for non-images.

- [ ] **Step 1: Write the failing test** — append to `imageutil_test.go`. Build a 2×2 image in code so the mean is exact.

```go
func TestAverageColor_meanHex(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	// Two black, two white pixels -> mean 127.5 -> 0x7f or 0x80 per channel.
	img.Set(0, 0, color.RGBA{0, 0, 0, 255})
	img.Set(1, 0, color.RGBA{0, 0, 0, 255})
	img.Set(0, 1, color.RGBA{255, 255, 255, 255})
	img.Set(1, 1, color.RGBA{255, 255, 255, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	hex, err := AverageColor(&buf)
	if err != nil {
		t.Fatalf("AverageColor: %v", err)
	}
	if hex != "#7f7f7f" && hex != "#808080" {
		t.Fatalf("AverageColor = %q, want mid-grey", hex)
	}
}

func TestAverageColor_rejectsNonImage(t *testing.T) {
	if _, err := AverageColor(strings.NewReader("not an image")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("err = %v, want ErrUnsupported", err)
	}
}
```

Add test imports: `"bytes"`, `"errors"`, `"image"`, `"image/color"`, `"image/png"`, `"strings"`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/imageutil/ 2>&1 | tail`
Expected: FAIL — `AverageColor` undefined.

- [ ] **Step 3: Implement** — add to `imageutil.go`. Use full `image.Decode` (register decoders already present). Average with a stride so large images stay cheap.

```go
// AverageColor decodes an image and returns the mean RGB as a #rrggbb hex string.
// It samples on a stride so multi-megapixel inputs stay cheap. Non-image input
// yields ErrUnsupported.
func AverageColor(r io.Reader) (string, error) {
	img, _, err := image.Decode(r)
	if err != nil {
		return "", ErrUnsupported
	}
	b := img.Bounds()
	if b.Empty() {
		return "", ErrUnsupported
	}
	stride := 1
	if n := b.Dx() * b.Dy(); n > 65536 {
		stride = int(math.Sqrt(float64(n) / 65536.0))
		if stride < 1 {
			stride = 1
		}
	}
	var sumR, sumG, sumB, count uint64
	for y := b.Min.Y; y < b.Max.Y; y += stride {
		for x := b.Min.X; x < b.Max.X; x += stride {
			r16, g16, b16, _ := img.At(x, y).RGBA() // 16-bit per channel
			sumR += uint64(r16 >> 8)
			sumG += uint64(g16 >> 8)
			sumB += uint64(b16 >> 8)
			count++
		}
	}
	if count == 0 {
		return "", ErrUnsupported
	}
	return fmt.Sprintf("#%02x%02x%02x", sumR/count, sumG/count, sumB/count), nil
}
```

Add imports `"fmt"`, `"math"` to `imageutil.go`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/imageutil/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/imageutil/
git commit -m "feat(imageutil): AverageColor for per-genre accent sampling"
```

---

## Task 5: Fold fanart/genre columns into the init migration

**Files:**
- Modify: `backend/internal/store/migrations/0001_init.sql`
- Test: `backend/internal/library/fanart_test.go` (new — a schema smoke test now; full repo tests in Task 6)

**Interfaces:**
- Produces: `fanart` gains `seed INTEGER`, `width INTEGER NOT NULL DEFAULT 0`, `height INTEGER NOT NULL DEFAULT 0`, `status TEXT NOT NULL DEFAULT 'ready'`, `error TEXT`. `genres` gains `accent_color TEXT`.

- [ ] **Step 1: Write the failing test** — create `backend/internal/library/fanart_test.go`. (Reuse the existing test DB helper; check `store_test.go`/`songs_test.go` for the helper name — it opens an in-memory DB and applies migrations. Assume `newTestRepo(t)` returns `(*Repo, context.Context)`; if the existing helper differs, match it.)

```go
package library

import "testing"

func TestMigration_fanartAndGenreImageryColumns(t *testing.T) {
	r, ctx := newTestRepo(t)
	// genres.accent_color exists and is nullable.
	if _, err := r.db.ExecContext(ctx, `INSERT INTO genres(id,name,accent_color) VALUES('g1','Jazz','#334455')`); err != nil {
		t.Fatalf("genres.accent_color: %v", err)
	}
	// fanart has the new columns with a status CHECK.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,genre_id,status,width,height,seed) VALUES('f1','fanart/f1.jpg','genre','g1','generating',0,0,42)`); err != nil {
		t.Fatalf("fanart new columns: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,status) VALUES('f2','','hero','bogus')`); err == nil {
		t.Fatal("expected status CHECK to reject 'bogus'")
	}
}
```

If the existing test helper has a different name/signature, adapt this test to it (grep `func newTest` / `func setup` in `library/*_test.go`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/library/ -run TestMigration_fanartAndGenreImageryColumns 2>&1 | tail`
Expected: FAIL — no such column `accent_color`.

- [ ] **Step 3: Implement** — edit `0001_init.sql`. In the `CREATE TABLE genres` add `accent_color TEXT`. Replace the `CREATE TABLE fanart (...)` block with the extended version (keep the existing comment style and the `idx_fanart_genre` index):

```sql
CREATE TABLE genres (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    accent_color TEXT                         -- auto-sampled from the active background (#rrggbb)
);
```

```sql
CREATE TABLE fanart (
    id         TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('hero', 'genre')),
    genre_id   TEXT REFERENCES genres(id) ON DELETE CASCADE,
    caption    TEXT,
    prompt     TEXT,                        -- when generated (server-only, never served to clients)
    model      TEXT,                        -- when generated (server-only, never served to clients)
    seed       INTEGER,                     -- when generated
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating', 'ready', 'failed')),
    error      TEXT,                        -- generation failure reason (server-only, auth-gated)
    is_active  INTEGER NOT NULL DEFAULT 0,  -- active background for its genre
    is_hero    INTEGER NOT NULL DEFAULT 0,  -- starred as featured Home hero
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_fanart_genre ON fanart(genre_id);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && go test ./internal/library/ -run TestMigration_fanartAndGenreImageryColumns`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/store/migrations/0001_init.sql backend/internal/library/fanart_test.go
git commit -m "feat(store): fold fanart status/seed/size + genre accent columns into 0001_init"
```

---

## Task 6: `library/fanart.go` — fanart & genre-imagery repo layer

**Files:**
- Create: `backend/internal/library/fanart.go`
- Modify: `backend/internal/library/browse.go` (add `AccentColor` to `GenreSummary`; scan `accent_color` in `GetGenre`)
- Test: `backend/internal/library/fanart_test.go` (extend)

**Interfaces:**
- Produces (all methods on `*Repo`):
  - `type Fanart struct { ID, Kind, GenreID, Status, Caption string; IsActive, IsHero bool; Width, Height int; ImagePath, Prompt, Model, ErrorMsg string; Seed *int64 }` — JSON tags: expose `id,kind,genreId,status,caption,isActive,isHero,width,height`; tag `ImagePath`/`Prompt`/`Model`/`ErrorMsg`/`Seed` as `json:"-"`.
  - `type FanartParams struct { Kind, GenreID, ImagePath, Caption, Prompt, Model, Status string; Width, Height int; Seed *int64 }`
  - `CreateFanart(ctx, FanartParams) (string, error)`
  - `CreateGeneratingFanart(ctx, kind, genreID, prompt, model string, seed *int64) (string, error)`
  - `MarkFanartReady(ctx, id, imagePath string, width, height int) error`
  - `MarkFanartFailed(ctx, id, reason string) error`
  - `GetFanart(ctx, id) (*Fanart, error)` — nil if not found; includes server-only fields.
  - `ListGenreFanart(ctx, genreID) ([]Fanart, error)` — ordered `is_active DESC, sort, created_at`.
  - `SetActiveBackground(ctx, genreID, fanartID) error` — validates the fanart is a `ready` `genre` row of that genre; sets `is_active=1` on it and `0` on the genre's others. Returns `ErrFanartNotInGenre` if invalid.
  - `SetGenreAccent(ctx, genreID, hex string) error`
  - `SetHero(ctx, fanartID) error` — sets `is_hero=1` on it, `0` on all others (single global hero).
  - `ClearHero(ctx, fanartID) error`
  - `UpdateGenreName(ctx, genreID, name string) error`
  - `DeleteFanart(ctx, id) (imagePath string, err error)`
- Consumes: `NewID()` (from `library/id.go`), the existing `*Repo`/`r.db`.

- [ ] **Step 1: Write failing tests** — extend `fanart_test.go`. Cover create→get scrub, generating→ready, generating→failed, active-background exclusivity, hero exclusivity, and accent set/read via `GetGenre`.

```go
func TestFanart_createGetAndJSONScrub(t *testing.T) {
	r, ctx := newTestRepo(t)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	seed := int64(7)
	id, err := r.CreateFanart(ctx, FanartParams{
		Kind: "genre", GenreID: "g1", ImagePath: "fanart/x.jpg", Status: "ready",
		Width: 1344, Height: 768, Prompt: "a smoky club", Model: "flux-2-klein-4b", Seed: &seed,
	})
	if err != nil {
		t.Fatal(err)
	}
	fa, err := r.GetFanart(ctx, id)
	if err != nil || fa == nil {
		t.Fatalf("GetFanart: %v", err)
	}
	if fa.Prompt != "a smoky club" || fa.Model == "" || fa.ImagePath == "" {
		t.Fatalf("server-only fields missing: %#v", fa)
	}
	// The JSON encoding must NOT contain prompt/model/image_path (no-AI-in-UI + sandbox).
	b, _ := json.Marshal(fa)
	for _, banned := range []string{"smoky club", "flux", "fanart/x.jpg", "prompt", "model", "imagePath"} {
		if strings.Contains(string(b), banned) {
			t.Fatalf("Fanart JSON leaked %q: %s", banned, b)
		}
	}
}

func TestFanart_generatingToReadyAndFailed(t *testing.T) {
	r, ctx := newTestRepo(t)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	a, _ := r.CreateGeneratingFanart(ctx, "genre", "g1", "p", "m", nil)
	if fa, _ := r.GetFanart(ctx, a); fa.Status != "generating" {
		t.Fatalf("status = %q", fa.Status)
	}
	if err := r.MarkFanartReady(ctx, a, "fanart/a.jpg", 1344, 768); err != nil {
		t.Fatal(err)
	}
	if fa, _ := r.GetFanart(ctx, a); fa.Status != "ready" || fa.Width != 1344 {
		t.Fatalf("ready = %#v", fa)
	}
	b, _ := r.CreateGeneratingFanart(ctx, "genre", "g1", "p", "m", nil)
	if err := r.MarkFanartFailed(ctx, b, "request moderated"); err != nil {
		t.Fatal(err)
	}
	if fa, _ := r.GetFanart(ctx, b); fa.Status != "failed" || fa.ErrorMsg != "request moderated" {
		t.Fatalf("failed = %#v", fa)
	}
}

func TestFanart_activeBackgroundExclusiveAndAccent(t *testing.T) {
	r, ctx := newTestRepo(t)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "fanart/1.jpg", Status: "ready"})
	f2, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "fanart/2.jpg", Status: "ready"})
	if err := r.SetActiveBackground(ctx, "g1", f1); err != nil {
		t.Fatal(err)
	}
	if err := r.SetActiveBackground(ctx, "g1", f2); err != nil {
		t.Fatal(err)
	}
	list, _ := r.ListGenreFanart(ctx, "g1")
	active := 0
	for _, fa := range list {
		if fa.IsActive {
			active++
			if fa.ID != f2 {
				t.Fatalf("wrong active: %s", fa.ID)
			}
		}
	}
	if active != 1 {
		t.Fatalf("active count = %d, want 1", active)
	}
	if err := r.SetGenreAccent(ctx, "g1", "#abcdef"); err != nil {
		t.Fatal(err)
	}
	g, _, _ := r.GetGenre(ctx, "g1")
	if g.AccentColor != "#abcdef" {
		t.Fatalf("accent = %q", g.AccentColor)
	}
}

func TestFanart_heroIsGlobalExclusive(t *testing.T) {
	r, ctx := newTestRepo(t)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "a", Status: "ready"})
	f2, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "b", Status: "ready"})
	if err := r.SetHero(ctx, f1); err != nil {
		t.Fatal(err)
	}
	if err := r.SetHero(ctx, f2); err != nil {
		t.Fatal(err)
	}
	a, _ := r.GetFanart(ctx, f1)
	b, _ := r.GetFanart(ctx, f2)
	if a.IsHero || !b.IsHero {
		t.Fatalf("hero exclusivity broken: a=%v b=%v", a.IsHero, b.IsHero)
	}
}

func TestSetActiveBackground_rejectsForeignFanart(t *testing.T) {
	r, ctx := newTestRepo(t)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz'),('g2','Rock')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "a", Status: "ready"})
	if err := r.SetActiveBackground(ctx, "g2", f1); !errors.Is(err, ErrFanartNotInGenre) {
		t.Fatalf("err = %v, want ErrFanartNotInGenre", err)
	}
}
```

Add a `mustExec` helper if not present:
```go
func mustExec(t *testing.T, r *Repo, sql string) {
	t.Helper()
	if _, err := r.db.ExecContext(context.Background(), sql); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}
```
Add test imports `"context"`, `"encoding/json"`, `"errors"`, `"strings"`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && go test ./internal/library/ -run TestFanart 2>&1 | tail`
Expected: FAIL — undefined `CreateFanart` etc.

- [ ] **Step 3: Implement** — create `fanart.go`:

```go
package library

import (
	"context"
	"database/sql"
	"errors"
)

// ErrFanartNotInGenre is returned when assigning a background/hero that does not
// belong to the target genre or is not a ready image.
var ErrFanartNotInGenre = errors.New("library: fanart does not belong to genre")

// Fanart is a fanart row. Server-only fields (ImagePath, Prompt, Model, ErrorMsg,
// Seed) are tagged json:"-" so no client — anonymous or authenticated — ever
// receives an image path, a generation prompt, a model name, or moderation text.
type Fanart struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	GenreID  string `json:"genreId"`
	Status   string `json:"status"`
	Caption  string `json:"caption"`
	IsActive bool   `json:"isActive"`
	IsHero   bool   `json:"isHero"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`

	ImagePath string `json:"-"`
	Prompt    string `json:"-"`
	Model     string `json:"-"`
	ErrorMsg  string `json:"-"`
	Seed      *int64 `json:"-"`
}

type FanartParams struct {
	Kind, GenreID, ImagePath, Caption, Prompt, Model, Status string
	Width, Height                                            int
	Seed                                                     *int64
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (r *Repo) CreateFanart(ctx context.Context, p FanartParams) (string, error) {
	if p.Status == "" {
		p.Status = "ready"
	}
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,genre_id,caption,prompt,model,seed,width,height,status)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, p.ImagePath, p.Kind, nullIfEmpty(p.GenreID), nullIfEmpty(p.Caption),
		nullIfEmpty(p.Prompt), nullIfEmpty(p.Model), p.Seed, p.Width, p.Height, p.Status)
	if err != nil {
		return "", err
	}
	return id, nil
}

func (r *Repo) CreateGeneratingFanart(ctx context.Context, kind, genreID, prompt, model string, seed *int64) (string, error) {
	return r.CreateFanart(ctx, FanartParams{
		Kind: kind, GenreID: genreID, ImagePath: "", Status: "generating",
		Prompt: prompt, Model: model, Seed: seed,
	})
}

func (r *Repo) MarkFanartReady(ctx context.Context, id, imagePath string, width, height int) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE fanart SET status='ready', image_path=?, width=?, height=?, error=NULL WHERE id=?`,
		imagePath, width, height, id)
	return err
}

func (r *Repo) MarkFanartFailed(ctx context.Context, id, reason string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE fanart SET status='failed', error=? WHERE id=?`, reason, id)
	return err
}

const fanartSelect = `SELECT id, kind, COALESCE(genre_id,''), status, COALESCE(caption,''),
	is_active, is_hero, width, height, image_path, COALESCE(prompt,''), COALESCE(model,''),
	COALESCE(error,''), seed FROM fanart`

func scanFanart(s interface{ Scan(...any) error }) (*Fanart, error) {
	var f Fanart
	var seed sql.NullInt64
	if err := s.Scan(&f.ID, &f.Kind, &f.GenreID, &f.Status, &f.Caption, &f.IsActive, &f.IsHero,
		&f.Width, &f.Height, &f.ImagePath, &f.Prompt, &f.Model, &f.ErrorMsg, &seed); err != nil {
		return nil, err
	}
	if seed.Valid {
		f.Seed = &seed.Int64
	}
	return &f, nil
}

func (r *Repo) GetFanart(ctx context.Context, id string) (*Fanart, error) {
	f, err := scanFanart(r.db.QueryRowContext(ctx, fanartSelect+` WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return f, err
}

func (r *Repo) ListGenreFanart(ctx context.Context, genreID string) ([]Fanart, error) {
	rows, err := r.db.QueryContext(ctx,
		fanartSelect+` WHERE genre_id=? ORDER BY is_active DESC, sort, created_at`, genreID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Fanart{}
	for rows.Next() {
		f, err := scanFanart(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

func (r *Repo) SetActiveBackground(ctx context.Context, genreID, fanartID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	err = tx.QueryRowContext(ctx,
		`SELECT status FROM fanart WHERE id=? AND genre_id=? AND kind='genre'`, fanartID, genreID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrFanartNotInGenre
	}
	if err != nil {
		return err
	}
	if status != "ready" {
		return ErrFanartNotInGenre
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_active=0 WHERE genre_id=?`, genreID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_active=1 WHERE id=?`, fanartID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) SetGenreAccent(ctx context.Context, genreID, hex string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE genres SET accent_color=? WHERE id=?`, hex, genreID)
	return err
}

func (r *Repo) SetHero(ctx context.Context, fanartID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT status FROM fanart WHERE id=?`, fanartID).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrFanartNotInGenre
		}
		return err
	}
	if status != "ready" {
		return ErrFanartNotInGenre
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_hero=0 WHERE is_hero=1`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fanart SET is_hero=1 WHERE id=?`, fanartID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) ClearHero(ctx context.Context, fanartID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE fanart SET is_hero=0 WHERE id=?`, fanartID)
	return err
}

func (r *Repo) UpdateGenreName(ctx context.Context, genreID, name string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE genres SET name=? WHERE id=?`, name, genreID)
	return err
}

func (r *Repo) DeleteFanart(ctx context.Context, id string) (string, error) {
	var path string
	err := r.db.QueryRowContext(ctx, `SELECT image_path FROM fanart WHERE id=?`, id).Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := r.db.ExecContext(ctx, `DELETE FROM fanart WHERE id=?`, id); err != nil {
		return "", err
	}
	return path, nil
}
```

Then modify `browse.go`: add `AccentColor string \`json:"accentColor"\`` to `GenreSummary`, and in **both** `ListGenres` and `GetGenre` select `COALESCE(g.accent_color,'')` and scan it. For `GetGenre`:

```go
	err := r.db.QueryRowContext(ctx,
		`SELECT g.id, g.name, COALESCE(g.accent_color,''), COUNT(sg.song_id) c
		 FROM genres g LEFT JOIN song_genres sg ON sg.genre_id = g.id
		 WHERE g.id = ? GROUP BY g.id`, id).Scan(&g.ID, &g.Name, &g.AccentColor, &g.SongCount)
```
And matching change for `ListGenres` (add `COALESCE(g.accent_color,'')` to SELECT and `&g.AccentColor` to Scan, keeping the `JOIN` and `GROUP BY`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && go test ./internal/library/ 2>&1 | tail`
Expected: PASS (all library tests, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/library/
git commit -m "feat(library): fanart repo layer + genre accent, with JSON scrubbing of server-only fields"
```

---

## Task 7: Extract shared upload-validation helper

**Files:**
- Modify: `backend/internal/httpapi/coverupload.go`
- Test: existing `backend/internal/httpapi/covers_test.go` must still pass (regression guard); no new test needed — behaviour is unchanged.

**Interfaces:**
- Produces: `func bufferProbeImage(w http.ResponseWriter, r *http.Request, maxBytes int64) (tmp *os.File, hash string, width, height int, ext string, ok bool)` — buffers the multipart `file`, hashes it, probes it, and rewinds `tmp` to the start. On any failure it writes the HTTP error and returns `ok=false`. Caller must `os.Remove(tmp.Name())` + `tmp.Close()` when `ok`.

- [ ] **Step 1: Refactor (no behaviour change)** — in `coverupload.go`, split the buffer/hash/probe portion out of `storeUploadedCover` into `bufferProbeImage`, and have `storeUploadedCover` call it. The extracted function contains everything from `r.Body = http.MaxBytesReader(...)` through the `imageutil.Probe` block, returning the open rewound temp file. `storeUploadedCover` keeps the dedupe + `covers/` write + `CreateCover`.

```go
func bufferProbeImage(w http.ResponseWriter, r *http.Request, maxBytes int64) (*os.File, string, int, int, string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpError(w, http.StatusRequestEntityTooLarge, "image exceeds size limit")
			return nil, "", 0, 0, "", false
		}
		httpError(w, http.StatusBadRequest, "missing file field")
		return nil, "", 0, 0, "", false
	}
	defer file.Close()
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	tmp, err := os.CreateTemp("", "music-image-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "temp file")
		return nil, "", 0, 0, "", false
	}
	cleanup := func() { _ = os.Remove(tmp.Name()); _ = tmp.Close() }

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), file); err != nil {
		cleanup()
		httpError(w, http.StatusBadRequest, "read upload")
		return nil, "", 0, 0, "", false
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		httpError(w, http.StatusInternalServerError, "seek")
		return nil, "", 0, 0, "", false
	}
	width, height, ext, err := imageutil.Probe(tmp)
	if err != nil {
		cleanup()
		httpError(w, http.StatusUnsupportedMediaType, "unsupported image format")
		return nil, "", 0, 0, "", false
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		httpError(w, http.StatusInternalServerError, "seek")
		return nil, "", 0, 0, "", false
	}
	return tmp, hash, width, height, ext, true
}
```

Then rewrite `storeUploadedCover` to call it:

```go
func storeUploadedCover(w http.ResponseWriter, r *http.Request, store *media.Store, repo *library.Repo, maxBytes int64) (string, bool) {
	tmp, hash, width, height, ext, ok := bufferProbeImage(w, r, maxBytes)
	if !ok {
		return "", false
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	coverID, _, err := repo.FindCoverByHash(r.Context(), hash)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cover lookup")
		return "", false
	}
	if coverID != "" {
		return coverID, true
	}
	relPath := "covers/" + hash + "." + ext
	dst, err := store.Create(relPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "store cover")
		return "", false
	}
	if _, err := io.Copy(dst, tmp); err != nil {
		dst.Close()
		httpError(w, http.StatusInternalServerError, "write cover")
		return "", false
	}
	if err := dst.Close(); err != nil {
		httpError(w, http.StatusInternalServerError, "close cover")
		return "", false
	}
	coverID, err = repo.CreateCover(r.Context(), library.CoverParams{
		ImagePath: relPath, Width: width, Height: height, ContentHash: hash,
	})
	if err != nil {
		_ = store.Remove(relPath)
		httpError(w, http.StatusInternalServerError, "save cover")
		return "", false
	}
	return coverID, true
}
```

- [ ] **Step 2: Run the existing cover tests**

Run: `cd backend && go test ./internal/httpapi/ -run Cover 2>&1 | tail`
Expected: PASS — behaviour unchanged.

- [ ] **Step 3: Commit**

```bash
git add backend/internal/httpapi/coverupload.go
git commit -m "refactor(httpapi): extract bufferProbeImage for reuse by fanart uploads"
```

---

## Task 8: Sized image serving with on-disk cache

**Files:**
- Create: `backend/internal/httpapi/imageserve.go`
- Modify: `backend/internal/httpapi/covers.go` (`getCover` honours `?size=`)
- Test: `backend/internal/httpapi/imageserve_test.go`

**Interfaces:**
- Produces: `func sizeParam(r *http.Request) (dim int, ok bool)` — maps `?size=thumb|card|hero` → `160|480|1600`; empty/absent → `ok=false` (serve original); unknown value → treat as original (`ok=false`). And `func serveSizedImage(w http.ResponseWriter, r *http.Request, store *media.Store, relPath string)` — serves `relPath`, or a cached/one-shot JPEG variant when `?size` is set. Cache path: `relPath + "." + sizeName + ".jpg"` inside the store.

- [ ] **Step 1: Write failing tests** — `imageserve_test.go`. Use a real `media.Store` over a temp dir and a real PNG written to it; assert that `hero` and `thumb` produce **different** byte lengths and that a second request hits the cache (same bytes).

```go
package httpapi

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/media"
)

func writeTestImage(t *testing.T, store *media.Store, rel string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	f, err := store.Create(rel)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func TestServeSizedImage_variantsDifferBySize(t *testing.T) {
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeTestImage(t, store, "covers/x.png", 2000, 2000)

	get := func(size string) []byte {
		req := httptest.NewRequest(http.MethodGet, "/api/cover/x?size="+size, nil)
		rec := httptest.NewRecorder()
		serveSizedImage(rec, req, store, "covers/x.png")
		if rec.Code != http.StatusOK {
			t.Fatalf("size %q: code %d", size, rec.Code)
		}
		return rec.Body.Bytes()
	}
	thumb, hero, full := get("thumb"), get("hero"), get("")
	if len(thumb) == 0 || len(hero) == 0 || len(full) == 0 {
		t.Fatal("empty body")
	}
	if len(thumb) >= len(hero) {
		t.Fatalf("thumb (%d) should be smaller than hero (%d)", len(thumb), len(hero))
	}
	if bytes.Equal(thumb, full) {
		t.Fatal("thumb must differ from the full original")
	}
	// Second request serves the identical cached variant.
	if !bytes.Equal(thumb, get("thumb")) {
		t.Fatal("cached thumb differs on second request")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run TestServeSizedImage 2>&1 | tail`
Expected: FAIL — `serveSizedImage` undefined.

- [ ] **Step 3: Implement** — `imageserve.go`:

```go
package httpapi

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"time"

	"github.com/trick77/music/internal/imagescale"
	"github.com/trick77/music/internal/media"
)

var imageSizes = map[string]int{"thumb": 160, "card": 480, "hero": 1600}

func sizeParam(r *http.Request) (int, string, bool) {
	name := r.URL.Query().Get("size")
	if dim, ok := imageSizes[name]; ok {
		return dim, name, true
	}
	return 0, "", false
}

// serveSizedImage serves relPath from the media store. With ?size=thumb|card|hero
// it serves (and caches on the volume) a downscaled JPEG variant; otherwise it
// serves the original bytes. All paths stay sandboxed via media.Store.
func serveSizedImage(w http.ResponseWriter, r *http.Request, store *media.Store, relPath string) {
	dim, name, sized := sizeParam(r)
	if !sized {
		serveStoreFile(w, r, store, relPath)
		return
	}
	cacheRel := relPath + "." + name + ".jpg"
	if f, err := store.Open(cacheRel); err == nil {
		defer f.Close()
		if info, err := f.Stat(); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			http.ServeContent(w, r, filepath.Base(cacheRel), info.ModTime(), f)
			return
		}
	}
	// Build the variant from the original.
	src, err := store.Open(relPath)
	if err != nil {
		httpError(w, http.StatusNotFound, "image missing")
		return
	}
	data, err := io.ReadAll(src)
	src.Close()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "read image")
		return
	}
	scaled, err := imagescale.Thumbnail(data, dim)
	if err != nil {
		// Undecodable as raster: fall back to the original bytes.
		serveStoreFile(w, r, store, relPath)
		return
	}
	if dst, err := store.Create(cacheRel); err == nil { // best-effort cache write
		_, _ = dst.Write(scaled)
		_ = dst.Close()
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, filepath.Base(cacheRel), time.Time{}, bytes.NewReader(scaled))
}

func serveStoreFile(w http.ResponseWriter, r *http.Request, store *media.Store, relPath string) {
	f, err := store.Open(relPath)
	if err != nil {
		httpError(w, http.StatusNotFound, "image missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "stat image")
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(relPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, filepath.Base(relPath), info.ModTime(), f)
}
```

Then simplify `covers.go`'s `getCover` to delegate: after resolving `path` from `GetCoverPath`, replace the manual open/serve block with `serveSizedImage(w, r, h.media, path)`.

```go
func (h *songHandlers) getCover(w http.ResponseWriter, r *http.Request) {
	path, err := h.repo.GetCoverPath(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get cover")
		return
	}
	serveSizedImage(w, r, h.media, path)
}
```
(Drop now-unused imports `mime`, `path/filepath` from `covers.go` if the linter flags them.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run 'TestServeSizedImage|Cover' 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/imageserve.go backend/internal/httpapi/covers.go
git commit -m "feat(httpapi): sized image variants (thumb/card/hero) with on-disk cache; covers use it"
```

---

## Task 9: Fanart upload, serve & meta endpoints

**Files:**
- Create: `backend/internal/httpapi/fanart.go`
- Test: `backend/internal/httpapi/fanart_test.go`

**Interfaces:**
- Consumes: `songHandlers{cfg, repo, media, maxBytes}` (already exists), `bufferProbeImage`, `serveSizedImage`, `library.Fanart`, `identify`.
- Produces handlers: `(h *songHandlers) postFanart`, `getFanart`, `getGenreExtended` (replaces `getGenre`).
  - `POST /api/fanart` (auth, multipart: `file`, `kind`, `genreId`) → 201 with `library.Fanart` JSON.
  - `GET /api/fanart/{id}` (public) → image bytes (honours `?size=`); `?meta=1` → JSON `{id,kind,genreId,status,isActive,isHero,width,height,caption}` plus `error` **only when the caller is authenticated**. `generating`/`failed`/missing image → 404 for the bytes path.
  - `GET /api/genres/{id}` (public) → `{genre:{...,accentColor}, songs, fanart:[...], backgroundId, heroId}`. `fanart` excludes `generating`/`failed` rows for anonymous; includes them for authenticated callers (so the editor sees in-flight tiles). Server-only fields never serialized (guaranteed by `Fanart` json tags).

- [ ] **Step 1: Write failing tests** — `fanart_test.go`. Use the existing httpapi test harness (grep `func newTestServer`/`func testServer` in `httpapi/*_test.go` and match it; it builds an `http.Handler` with a dev-auth config and a temp media dir). Cover: upload happy path, anonymous upload → 403, meta scrubbing, and generating rows hidden from anonymous genre reads.

```go
func TestPostFanart_uploadAndAssignGenre(t *testing.T) {
	ts := newFanartTestServer(t) // helper below
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.uploadFanart(t, "genre", genreID, pngBytes(t, 8, 8))
	if rec.Code != http.StatusCreated {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	if s := rec.Body.String(); strings.Contains(s, "image_path") || strings.Contains(s, "\"prompt\"") {
		t.Fatalf("upload response leaked server-only fields: %s", s)
	}
}

func TestPostFanart_anonymousForbidden(t *testing.T) {
	ts := newFanartTestServerAnon(t) // oidc mode -> anonymous
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.uploadFanart(t, "genre", genreID, pngBytes(t, 8, 8))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("anonymous upload code = %d, want 403", rec.Code)
	}
}

func TestGetFanartMeta_scrubbedForAnonymous(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	id := ts.seedFailedGeneratedFanart(t, genreID, "smoky club prompt", "request moderated")
	// Anonymous meta: no error text, no prompt.
	body := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", false)
	if strings.Contains(body, "smoky club") || strings.Contains(body, "moderated") {
		t.Fatalf("anonymous meta leaked AI/error text: %s", body)
	}
	// Authenticated meta: error surfaced (for the editor), still no prompt.
	abody := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true)
	if !strings.Contains(abody, "moderated") {
		t.Fatalf("authenticated meta should include error: %s", abody)
	}
	if strings.Contains(abody, "smoky club") {
		t.Fatalf("meta must never include the prompt: %s", abody)
	}
}
```

Write the small harness helpers (`newFanartTestServer`, `seedGenre`, `uploadFanart` building a multipart body, `pngBytes`, `getJSON` with/without dev auth, `seedFailedGeneratedFanart` inserting a row via the store) at the bottom of the test file, matching the existing harness patterns. If the existing suite already exposes an `http.Handler` + repo accessor, reuse it rather than duplicating.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run 'Fanart' 2>&1 | tail`
Expected: FAIL — handlers undefined.

- [ ] **Step 3: Implement** — `fanart.go`. Genre-write validation: `kind` must be `genre` or `hero`; when `genre`, `genreId` required and must exist.

```go
package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/trick77/music/internal/library"
)

func (h *songHandlers) postFanart(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	// Parse fields BEFORE the file so form values are available; bufferProbeImage
	// enforces the size cap on the streamed file part.
	tmp, hash, width, height, ext, ok := bufferProbeImage(w, r, h.maxBytes)
	if !ok {
		return
	}
	defer removeTemp(tmp)
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
		httpError(w, http.StatusInternalServerError, "store fanart")
		return
	}
	id, err := h.repo.CreateFanart(r.Context(), library.FanartParams{
		Kind: kind, GenreID: genreID, ImagePath: relPath, Width: width, Height: height, Status: "ready",
	})
	if err != nil {
		_ = h.media.Remove(relPath)
		httpError(w, http.StatusInternalServerError, "save fanart")
		return
	}
	fa, err := h.repo.GetFanart(r.Context(), id)
	if err != nil || fa == nil {
		httpError(w, http.StatusInternalServerError, "reload fanart")
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, fa)
}

func (h *songHandlers) getFanart(w http.ResponseWriter, r *http.Request) {
	fa, err := h.repo.GetFanart(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get fanart")
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
```

Small shared helpers (put in `fanart.go` or `imageserve.go`):

```go
func removeTemp(tmp interface{ Name() string; Close() error }) {
	_ = tmp.Close()
}
```
Actually `bufferProbeImage` returns `*os.File`; reuse its own `defer os.Remove/Close` pattern instead of a wrapper. Replace `defer removeTemp(tmp)` with:
```go
	defer os.Remove(tmp.Name())
	defer tmp.Close()
```
and add `writeStoreFile`:
```go
func writeStoreFile(store *media.Store, relPath string, src io.Reader) error {
	dst, err := store.Create(relPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}
```
(Add imports `os`, `media`, `io` as needed.)

Now replace `getGenre` in `browse.go`'s handler (`httpapi/browse.go`) with an extended version — put it in `fanart.go` and update the route in Task 13 to point at it:

```go
func (h *songHandlers) getGenreExtended(w http.ResponseWriter, r *http.Request) {
	genre, songs, err := h.repo.GetGenre(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get genre")
		return
	}
	if genre == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	all, err := h.repo.ListGenreFanart(r.Context(), genre.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list fanart")
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
```

Remove the old `getGenre` from `httpapi/browse.go` (its route will be repointed in Task 13). Keep `listGenres`.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run 'Fanart|Genre' 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/fanart.go backend/internal/httpapi/fanart_test.go backend/internal/httpapi/browse.go
git commit -m "feat(httpapi): fanart upload/serve/meta + extended genre read, server-only fields scrubbed"
```

---

## Task 10: `PATCH /api/genres/{id}` — rename, set background (+accent), star/clear hero

**Files:**
- Create: `backend/internal/httpapi/genres.go`
- Test: `backend/internal/httpapi/genres_test.go`

**Interfaces:**
- Consumes: repo methods from Task 6, `imageutil.AverageColor`, `media.Store`.
- Produces: `(h *songHandlers) patchGenre` — `PATCH /api/genres/{id}` (auth) body `{name?, backgroundFanartId?, heroFanartId?, clearHero?}`. On `backgroundFanartId`: `SetActiveBackground` then re-sample accent from that image's bytes and `SetGenreAccent`. Returns the same shape as `getGenreExtended`.

- [ ] **Step 1: Write failing tests** — `genres_test.go`: rename; set-background sets `is_active` and populates `accentColor`; foreign fanart → 400; anonymous → 403.

```go
func TestPatchGenre_setBackgroundSamplesAccent(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	// Upload a solid-red image so the sampled accent is predictable.
	up := ts.uploadFanart(t, "genre", genreID, solidPngBytes(t, 16, 16, 220, 30, 30))
	fanartID := ts.idFromResponse(t, up)
	rec := ts.patchGenreJSON(t, genreID, map[string]any{"backgroundFanartId": fanartID}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	var out struct {
		Genre struct {
			AccentColor string `json:"accentColor"`
		} `json:"genre"`
		BackgroundID string `json:"backgroundId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out.BackgroundID != fanartID {
		t.Fatalf("backgroundId = %q", out.BackgroundID)
	}
	if out.Genre.AccentColor == "" || out.Genre.AccentColor[0] != '#' {
		t.Fatalf("accent not sampled: %q", out.Genre.AccentColor)
	}
}

func TestPatchGenre_anonymousForbidden(t *testing.T) {
	ts := newFanartTestServerAnon(t)
	rec := ts.patchGenreJSON(t, ts.seedGenre(t, "Jazz"), map[string]any{"name": "X"}, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run TestPatchGenre 2>&1 | tail`
Expected: FAIL — `patchGenre` undefined.

- [ ] **Step 3: Implement** — `genres.go`:

```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

type patchGenreRequest struct {
	Name               *string `json:"name"`
	BackgroundFanartID *string `json:"backgroundFanartId"`
	HeroFanartID       *string `json:"heroFanartId"`
	ClearHero          *string `json:"clearHero"`
}

func (h *songHandlers) patchGenre(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	genreID := r.PathValue("id")
	g, _, err := h.repo.GetGenre(r.Context(), genreID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get genre")
		return
	}
	if g == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	var req patchGenreRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Name != nil {
		if *req.Name == "" {
			httpError(w, http.StatusBadRequest, "name cannot be empty")
			return
		}
		if err := h.repo.UpdateGenreName(r.Context(), genreID, *req.Name); err != nil {
			httpError(w, http.StatusInternalServerError, "rename genre")
			return
		}
	}
	if req.BackgroundFanartID != nil {
		if err := h.repo.SetActiveBackground(r.Context(), genreID, *req.BackgroundFanartID); err != nil {
			if errors.Is(err, library.ErrFanartNotInGenre) {
				httpError(w, http.StatusBadRequest, "image is not a ready background for this genre")
				return
			}
			httpError(w, http.StatusInternalServerError, "set background")
			return
		}
		h.resampleAccent(r, genreID, *req.BackgroundFanartID)
	}
	if req.HeroFanartID != nil {
		if err := h.repo.SetHero(r.Context(), *req.HeroFanartID); err != nil {
			if errors.Is(err, library.ErrFanartNotInGenre) {
				httpError(w, http.StatusBadRequest, "image is not ready")
				return
			}
			httpError(w, http.StatusInternalServerError, "set hero")
			return
		}
	}
	if req.ClearHero != nil {
		if err := h.repo.ClearHero(r.Context(), *req.ClearHero); err != nil {
			httpError(w, http.StatusInternalServerError, "clear hero")
			return
		}
	}
	h.getGenreExtended(w, r) // return the fresh state
}

// resampleAccent reads the background image and stores its mean colour as the
// genre accent. Best-effort: a sampling failure leaves the prior accent intact.
func (h *songHandlers) resampleAccent(r *http.Request, genreID, fanartID string) {
	fa, err := h.repo.GetFanart(r.Context(), fanartID)
	if err != nil || fa == nil || fa.ImagePath == "" {
		return
	}
	f, err := h.media.Open(fa.ImagePath)
	if err != nil {
		return
	}
	data, err := io.ReadAll(f)
	f.Close()
	if err != nil {
		return
	}
	hex, err := imageutil.AverageColor(bytes.NewReader(data))
	if err != nil {
		return
	}
	_ = h.repo.SetGenreAccent(r.Context(), genreID, hex)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run TestPatchGenre 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/genres.go backend/internal/httpapi/genres_test.go
git commit -m "feat(httpapi): PATCH /api/genres/{id} — rename, set background+accent, star hero"
```

---

## Task 11: Async AI generation with injected Provider

**Files:**
- Create: `backend/internal/httpapi/fanart_generate.go`
- Modify: `backend/internal/httpapi/songs.go` (add `imageGen`, `bflModel`, `onGenComplete` fields to `songHandlers`)
- Test: `backend/internal/httpapi/fanart_generate_test.go`

**Interfaces:**
- Consumes: `imagegen.Provider`, `imagegen.GenerateRequest`/`GenerateResult`, repo generating-state methods, `imageutil.Probe`.
- Produces:
  - `songHandlers` new fields: `imageGen imagegen.Provider` (nil = disabled), `bflModel string`, `onGenComplete func(id string)` (nil in prod; a test hook fired after the goroutine finishes a row — success or failure).
  - Constants `genWidth = 1344`, `genHeight = 768`.
  - `(h *songHandlers) postFanartGenerate` — `POST /api/fanart/generate` (auth). If `h.imageGen == nil` → 404 `"image generation is not configured"`. Body `{prompt, kind, genreId?}`. Creates a generating row, spawns `go h.runGeneration(id, prompt)`, returns 202 `{id, status:"generating"}`.
  - `(h *songHandlers) runGeneration(id, prompt string)` — detached context with `cfg.BFLPollTimeout + 30s`; on success stores bytes to `fanart/<id>.<ext>`, probes dims, `MarkFanartReady`; on error `MarkFanartFailed(err.Error())`; always fires `onGenComplete`.

- [ ] **Step 1: Write failing tests** — `fanart_generate_test.go`. Inject a fake Provider; use `onGenComplete` (a channel) to await the transition deterministically — **no sleeps**.

```go
type fakeProvider struct {
	result imagegen.GenerateResult
	err    error
}

func (f fakeProvider) Generate(context.Context, imagegen.GenerateRequest) (imagegen.GenerateResult, error) {
	return f.result, f.err
}

func TestGenerate_generatingThenReady(t *testing.T) {
	done := make(chan string, 1)
	ts := newFanartTestServerWithGen(t, fakeProvider{
		result: imagegen.GenerateResult{Bytes: pngBytes(t, 1344, 768), MIMEType: "image/png", Extension: "png"},
	}, func(id string) { done <- id })
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "a smoky club", "kind": "genre", "genreId": genreID})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	id := ts.idFromResponse(t, rec)
	// Response must not echo the prompt.
	if strings.Contains(rec.Body.String(), "smoky club") {
		t.Fatalf("generate response leaked prompt: %s", rec.Body)
	}
	<-done // goroutine finished
	body := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true)
	if !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("status not ready: %s", body)
	}
}

func TestGenerate_moderatedBecomesFailed(t *testing.T) {
	done := make(chan string, 1)
	ts := newFanartTestServerWithGen(t, fakeProvider{err: errors.New("BFL blocked the prompt (request moderated)")},
		func(id string) { done <- id })
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "x", "kind": "genre", "genreId": genreID})
	id := ts.idFromResponse(t, rec)
	<-done
	// Authenticated meta shows failed + reason; anonymous shows neither.
	if !strings.Contains(ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true), `"status":"failed"`) {
		t.Fatal("expected failed status for authed meta")
	}
	if strings.Contains(ts.getJSON(t, "/api/fanart/"+id+"?meta=1", false), "moderated") {
		t.Fatal("anonymous meta leaked moderation text")
	}
}

func TestGenerate_disabledWhenNoKey(t *testing.T) {
	ts := newFanartTestServer(t) // no Provider wired
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "x", "kind": "genre", "genreId": genreID})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 when generation disabled", rec.Code)
	}
}
```

Add the `newFanartTestServerWithGen(t, provider, onDone)` harness variant that sets `songHandlers.imageGen` + `onGenComplete`. Since `songHandlers` is constructed inside `httpapi.New`, expose a test seam: have `New` read `imageGen`/`onGenComplete` from `cfg`-independent wiring — simplest is a package-level constructor used by tests. **Recommended seam:** add an exported `NewWithProvider(cfg, st, spa, gen imagegen.Provider, onGenComplete func(string)) http.Handler` that `New` delegates to (`New` passes `nil, nil`). The test harness calls `NewWithProvider`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run TestGenerate 2>&1 | tail`
Expected: FAIL — undefined handler/fields.

- [ ] **Step 3: Implement** — add fields to the `songHandlers` struct in `songs.go`:

```go
	imageGen      imagegen.Provider
	bflModel      string
	onGenComplete func(id string)
```

Create `fanart_generate.go`:

```go
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

const (
	genWidth  = 1344
	genHeight = 768
)

type generateRequest struct {
	Prompt  string `json:"prompt"`
	Kind    string `json:"kind"`
	GenreID string `json:"genreId"`
}

func (h *songHandlers) postFanartGenerate(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.imageGen == nil {
		httpError(w, http.StatusNotFound, "image generation is not configured")
		return
	}
	var req generateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Prompt == "" {
		httpError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if req.Kind != "genre" && req.Kind != "hero" {
		httpError(w, http.StatusBadRequest, "kind must be 'genre' or 'hero'")
		return
	}
	if req.Kind == "genre" && (req.GenreID == "" || !h.genreExists(r, req.GenreID)) {
		httpError(w, http.StatusBadRequest, "unknown genre")
		return
	}
	if req.Kind == "hero" {
		req.GenreID = ""
	}
	id, err := h.repo.CreateGeneratingFanart(r.Context(), req.Kind, req.GenreID, req.Prompt, h.bflModel, nil)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "create fanart")
		return
	}
	go h.runGeneration(id, req.Prompt)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"id": id, "status": "generating"})
}

// runGeneration drives one BFL generation to completion on a detached context and
// records the terminal state. The prompt/model live only in the DB (never served).
func (h *songHandlers) runGeneration(id, prompt string) {
	if h.onGenComplete != nil {
		defer h.onGenComplete(id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), h.cfg.BFLPollTimeout+30*time.Second)
	defer cancel()

	res, err := h.imageGen.Generate(ctx, imagegen.GenerateRequest{
		Prompt: prompt, Width: genWidth, Height: genHeight, OutputFormat: "png",
	})
	if err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, err.Error())
		return
	}
	ext := res.Extension
	if ext == "" {
		ext = "png"
	}
	relPath := "fanart/" + id + "." + ext
	if err := writeBytes(h.media, relPath, res.Bytes); err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, "store generated image")
		return
	}
	width, height := res.Width, res.Height
	if w, hh, _, perr := imageutil.Probe(bytesReader(res.Bytes)); perr == nil {
		width, height = w, hh
	}
	if err := h.repo.MarkFanartReady(ctx, id, relPath, width, height); err != nil {
		_ = h.repo.MarkFanartFailed(ctx, id, "record generated image")
	}
	_ = library.Fanart{} // (import anchor; remove if unused)
}
```

Add tiny helpers (in `imageserve.go` or here): `writeBytes(store, rel, b)` (Create+Write+Close) and `bytesReader(b) io.Reader` = `bytes.NewReader`. Remove the `library.Fanart{}` anchor line and the `library` import if not otherwise used.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run TestGenerate 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/fanart_generate.go backend/internal/httpapi/songs.go backend/internal/httpapi/fanart_generate_test.go
git commit -m "feat(httpapi): async BFL fanart generation via injected Provider; degrades to 404 with no key"
```

---

## Task 12: Expose `imageGenEnabled` on the session endpoint (auth-gated)

**Files:**
- Modify: `backend/internal/httpapi/server.go` (the `GET /api/auth/session` handler)
- Test: `backend/internal/httpapi/server_test.go`

**Interfaces:**
- Produces: session JSON gains `imageGenEnabled bool`, computed as `cfg.ImageGenEnabled() && id.Authenticated` — so anonymous callers always see `false` and never any generation hint.

- [ ] **Step 1: Write the failing test** — append to `server_test.go`.

```go
func TestSession_imageGenEnabledGatedByAuthAndKey(t *testing.T) {
	// dev mode (authenticated) + BFL key => true
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}, BFLAPIKey: "k"}
	rec := doGet(t, httpapi.New(cfg, nil, http.NotFoundHandler()), "/api/auth/session")
	if !bodyHas(rec, `"imageGenEnabled":true`) {
		t.Fatalf("dev+key should be true: %s", rec.Body)
	}
	// oidc mode (anonymous) + BFL key => false
	cfg.AuthMode = config.AuthModeOIDC
	rec = doGet(t, httpapi.New(cfg, nil, http.NotFoundHandler()), "/api/auth/session")
	if !bodyHas(rec, `"imageGenEnabled":false`) {
		t.Fatalf("anonymous must be false: %s", rec.Body)
	}
}
```

Match the existing `server_test.go` helpers (adapt `doGet`/`bodyHas` to whatever the file already uses; if none, inline `httptest`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run TestSession_imageGen 2>&1 | tail`
Expected: FAIL — key absent from response.

- [ ] **Step 3: Implement** — in `server.go`, update the session handler:

```go
	mux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		id := identify(cfg, r)
		writeJSON(w, map[string]any{
			"authenticated":   id.Authenticated,
			"username":        id.Username,
			"imageGenEnabled": cfg.ImageGenEnabled() && id.Authenticated,
		})
	})
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run TestSession 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/server.go backend/internal/httpapi/server_test.go
git commit -m "feat(httpapi): expose imageGenEnabled on session, gated by auth AND key presence"
```

---

## Task 13: Wire routes & build the BFL client

**Files:**
- Modify: `backend/internal/httpapi/server.go`
- Test: `backend/internal/httpapi/fanart_test.go` (add a route-presence assertion) — or rely on the Task 9–12 tests which already exercise the routes through `New`/`NewWithProvider`.

**Interfaces:**
- Produces: `NewWithProvider(cfg, st, spa, gen imagegen.Provider, onGenComplete func(string)) http.Handler`; `New` delegates with `nil, nil`. When `gen == nil && cfg.ImageGenEnabled()`, `New` builds a real `imagegen.NewBFLClient(...)`. Routes registered: `POST /api/fanart`, `GET /api/fanart/{id}`, `POST /api/fanart/generate`, `PATCH /api/genres/{id}`, and `GET /api/genres/{id}` → `getGenreExtended`.

- [ ] **Step 1: Refactor `New` → `NewWithProvider`** and register routes. Inside the `if st != nil && cfg.MediaDir != ""` block, after building `h`:

```go
	// Real BFL client when generation is configured and no provider was injected (tests inject one).
	if gen == nil && cfg.ImageGenEnabled() {
		gen = imagegen.NewBFLClient(imagegen.BFLConfig{
			BaseURL: cfg.BFLBaseURL, APIKey: cfg.BFLAPIKey, Model: cfg.BFLModel,
			PollTimeout: cfg.BFLPollTimeout,
		})
	}
	h.imageGen = gen
	h.bflModel = cfg.BFLModel
	h.onGenComplete = onGenComplete
```

Register (near the existing genre routes; replace the `getGenre` handler ref):

```go
	mux.HandleFunc("GET /api/genres/{id}", h.getGenreExtended)
	mux.HandleFunc("PATCH /api/genres/{id}", h.patchGenre)
	mux.HandleFunc("POST /api/fanart", h.postFanart)
	mux.HandleFunc("GET /api/fanart/{id}", h.getFanart)
	mux.HandleFunc("POST /api/fanart/generate", h.postFanartGenerate)
```

And add:
```go
func New(cfg config.Config, st *store.Store, spa http.Handler) http.Handler {
	return NewWithProvider(cfg, st, spa, nil, nil)
}

func NewWithProvider(cfg config.Config, st *store.Store, spa http.Handler, gen imagegen.Provider, onGenComplete func(string)) http.Handler {
	// ... existing body, using gen/onGenComplete ...
}
```
Add the `imagegen` import to `server.go`.

- [ ] **Step 2: Run the whole httpapi + build**

Run: `cd backend && go build ./... && go test ./internal/httpapi/ 2>&1 | tail`
Expected: PASS.

- [ ] **Step 3: Full backend test + vet**

Run: `cd backend && go vet ./... && CGO_ENABLED=0 go test ./... 2>&1 | tail`
Expected: all `ok`.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/httpapi/server.go
git commit -m "feat(httpapi): wire fanart/genre routes and build BFL client when configured"
```

---

## Task 14: `.env.example` — BFL vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Verify current contents**

Run: `grep -n BFL .env.example || echo "no BFL block"`

- [ ] **Step 2: If absent, append the block** (matches spec §13 verbatim):

```dotenv

# --- Image generation (optional; leave API key empty to disable the Generate button) ---
BACKEND_BFL_BASE_URL=https://api.bfl.ai/v1
BACKEND_BFL_API_KEY=
BACKEND_BFL_MODEL=flux-2-klein-4b
BACKEND_BFL_POLL_TIMEOUT=1m
```

If a BFL block already exists, ensure the four keys + values match exactly and skip duplication.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document optional BFL image-generation vars"
```

---

## Task 15: Frontend API — genre/fanart types & calls

**Files:**
- Modify: `ui/src/api.ts`
- Create: `ui/src/fanart.ts`, `ui/src/fanart.test.ts`

**Interfaces:**
- Produces (in `api.ts`):
  - `Session` gains `imageGenEnabled: boolean`.
  - `type Fanart = { id, kind, genreId, status: "generating"|"ready"|"failed", caption, isActive, isHero, width, height, error?: string }`.
  - `type GenreSummary = { id, name, songCount, accentColor }`.
  - `type GenreDetail = { genre: GenreSummary, songs: Song[], fanart: Fanart[], backgroundId: string, heroId: string }`.
  - `listGenres(): Promise<GenreSummary[]>`, `getGenre(id): Promise<GenreDetail>`, `uploadFanart(kind, genreId, file): Promise<Fanart>`, `generateFanart(prompt, kind, genreId): Promise<{id:string;status:string}>`, `getFanartMeta(id): Promise<Fanart>`, `patchGenre(id, body): Promise<GenreDetail>`.
- Produces (in `fanart.ts`): `fanartUrl(id: string, size?: "thumb"|"card"|"hero"): string`, `genreInitial(name: string): string`.

- [ ] **Step 1: Write the failing test** — `fanart.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fanartUrl, genreInitial } from "./fanart";

describe("fanartUrl", () => {
  it("builds a plain URL with no size", () => {
    expect(fanartUrl("abc")).toBe("/api/fanart/abc");
  });
  it("appends the size param", () => {
    expect(fanartUrl("abc", "hero")).toBe("/api/fanart/abc?size=hero");
  });
  it("returns empty string for a missing id", () => {
    expect(fanartUrl("")).toBe("");
  });
});

describe("genreInitial", () => {
  it("uppercases the first letter", () => {
    expect(genreInitial("jazz")).toBe("J");
  });
  it("falls back to ? when empty", () => {
    expect(genreInitial("  ")).toBe("?");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run fanart.test.ts`
Expected: FAIL — module `./fanart` not found.

- [ ] **Step 3: Implement** — `fanart.ts`:

```ts
export type FanartSize = "thumb" | "card" | "hero";

export function fanartUrl(id: string, size?: FanartSize): string {
  if (!id) return "";
  return size ? `/api/fanart/${id}?size=${size}` : `/api/fanart/${id}`;
}

export function genreInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
```

Then extend `api.ts`: add `imageGenEnabled: boolean` to `Session`, add the types and functions above. Example bodies:

```ts
export type Fanart = {
  id: string;
  kind: "genre" | "hero";
  genreId: string;
  status: "generating" | "ready" | "failed";
  caption: string;
  isActive: boolean;
  isHero: boolean;
  width: number;
  height: number;
  error?: string;
};

export type GenreSummary = { id: string; name: string; songCount: number; accentColor: string };
export type GenreDetail = {
  genre: GenreSummary;
  songs: Song[];
  fanart: Fanart[];
  backgroundId: string;
  heroId: string;
};

export async function listGenres(): Promise<GenreSummary[]> {
  const r = await fetch("/api/genres");
  if (!r.ok) throw new Error("failed to load genres");
  return (await r.json()).genres ?? [];
}

export async function getGenre(id: string): Promise<GenreDetail> {
  const r = await fetch(`/api/genres/${id}`);
  if (!r.ok) throw new Error(`failed to load genre (${r.status})`);
  return r.json();
}

export async function uploadFanart(kind: "genre" | "hero", genreId: string, file: File): Promise<Fanart> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  form.append("genreId", genreId);
  const r = await fetch("/api/fanart", { method: "POST", body: form });
  if (!r.ok) throw new Error(`fanart upload failed (${r.status})`);
  return r.json();
}

export async function generateFanart(prompt: string, kind: "genre" | "hero", genreId: string): Promise<{ id: string; status: string }> {
  const r = await fetch("/api/fanart/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, kind, genreId }),
  });
  if (!r.ok) throw new Error(`generate failed (${r.status})`);
  return r.json();
}

export async function getFanartMeta(id: string): Promise<Fanart> {
  const r = await fetch(`/api/fanart/${id}?meta=1`);
  if (!r.ok) throw new Error(`fanart meta failed (${r.status})`);
  return r.json();
}

export async function patchGenre(
  id: string,
  body: { name?: string; backgroundFanartId?: string; heroFanartId?: string; clearHero?: string },
): Promise<GenreDetail> {
  const r = await fetch(`/api/genres/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npm run test -- --run fanart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/fanart.ts ui/src/fanart.test.ts
git commit -m "feat(ui): genre/fanart API client + fanartUrl helpers"
```

---

## Task 16: Genre routes

**Files:**
- Modify: `ui/src/router.ts`
- Test: `ui/src/router.test.ts`

**Interfaces:**
- Produces: `Route` union gains `{ name: "genres" }` and `{ name: "genre"; id: string }`. `parsePath("/genres")` and `parsePath("/genre/g1")` return them.

- [ ] **Step 1: Write the failing test** — append to `router.test.ts` (match its existing style):

```ts
it("parses the genres list route", () => {
  expect(parsePath("/genres")).toEqual({ name: "genres" });
});
it("parses a genre detail route", () => {
  expect(parsePath("/genre/g1")).toEqual({ name: "genre", id: "g1" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `router.ts` add to the `Route` union and `parsePath`:

```ts
  | { name: "genres" }
  | { name: "genre"; id: string }
```
```ts
  if (parts.length === 1 && parts[0] === "genres") return { name: "genres" };
  if (parts.length === 2 && parts[0] === "genre") return { name: "genre", id: parts[1] };
```
(Place the genre-detail check alongside the existing `song`/`playlist` two-part checks.)

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npm run test -- --run router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/router.ts ui/src/router.test.ts
git commit -m "feat(ui): genres list + genre detail routes"
```

---

## Task 17: Genre detail page (minimal) + Genres tab

**Files:**
- Create: `ui/src/GenreDetail.tsx`
- Modify: `ui/src/App.tsx` (route wiring, pass `session`), `ui/src/Library.tsx` (a "Genres" tab that lists genres and links to `/genre/{id}`)

**Interfaces:**
- Consumes: `getGenre`, `listGenres`, `fanartUrl`, `genreInitial`, `Session`.
- Produces: `GenreDetail({ id, authenticated, imageGenEnabled, onPlay })` React component rendering the background (via `fanartUrl(backgroundId, "hero")` with a graceful gradient fallback when absent), a scrim, the genre name, its song list, and — when `authenticated` — an **Edit** button that opens `GenreEditor` (Task 18). This task renders the page and Edit button; the button opens a placeholder until Task 18 lands (or implement 17+18 back-to-back).

- [ ] **Step 1: Implement `GenreDetail.tsx`** (no unit test — validated via Vitest render in Task 18's editor test + Playwright). Minimal, token-styled:

```tsx
import { useEffect, useState } from "react";
import { getGenre, type GenreDetail as GD, type Song } from "./api";
import { fanartUrl, genreInitial } from "./fanart";
import { navigate } from "./router";
import { GenreEditor } from "./GenreEditor";

type Props = { id: string; authenticated: boolean; imageGenEnabled: boolean; onPlay: (s: Song) => void };

export function GenreDetail({ id, authenticated, imageGenEnabled, onPlay }: Props) {
  const [data, setData] = useState<GD | null>(null);
  const [editing, setEditing] = useState(false);
  const load = () => getGenre(id).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [id]);

  if (!data) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;
  const bg = fanartUrl(data.backgroundId, "hero");
  const accent = data.genre.accentColor || "var(--color-accent)";

  return (
    <div>
      <button onClick={() => navigate("/genres")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Genres</button>
      <div style={{
        position: "relative", borderRadius: 16, overflow: "hidden", minHeight: 220,
        display: "flex", alignItems: "flex-end", padding: "1.25rem",
        background: bg ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.75)), url(${bg}) center/cover`
                       : `linear-gradient(135deg, ${accent}, var(--color-panel))`,
      }}>
        {!bg && <span aria-hidden style={{ position: "absolute", top: 12, left: 16, fontSize: "2rem", opacity: 0.5, fontFamily: "var(--font-serif)" }}>{genreInitial(data.genre.name)}</span>}
        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-end", width: "100%" }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.6)" }}>{data.genre.name}</h1>
          {authenticated && (
            <button onClick={() => setEditing(true)} style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.35)", color: "#fff", borderRadius: 8, padding: "0.4rem 0.9rem", cursor: "pointer" }}>Edit</button>
          )}
        </div>
      </div>

      <ul style={{ listStyle: "none", padding: 0, marginTop: "1.25rem" }}>
        {data.songs.map((s) => (
          <li key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 0", borderBottom: "1px solid var(--color-border)" }}>
            <button onClick={() => onPlay(s)} style={{ background: "none", border: "none", color: "var(--color-ink)", cursor: "pointer", textAlign: "left" }}>
              {s.title} <span style={{ color: "var(--color-muted)" }}>— {s.artistName}</span>
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <GenreEditor
          detail={data}
          imageGenEnabled={imageGenEnabled}
          onClose={() => setEditing(false)}
          onChanged={() => load()}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into `App.tsx`** — add a route branch and a Genres nav. In the route ternary add before the final `Library`:

```tsx
) : route.name === "genre" ? (
  <GenreDetail id={route.id} authenticated={authed} imageGenEnabled={!!session?.imageGenEnabled} onPlay={(s) => play(s)} />
```
Import `GenreDetail`. Ensure `Library` receives a way to reach genres — pass `initialTab="genres"` when `route.name === "genres"` (extend the `initialTab` prop mapping) — see next step.

- [ ] **Step 3: Add a "Genres" tab to `Library.tsx`** — extend `Tab` to include `"genres"`, fetch `listGenres()` when active, render a grid of genre cards each linking via `navigate('/genre/'+g.id)`. Keep it minimal and token-styled. Add `"genres"` to the tab button array.

```tsx
// Tab type:
type Tab = "all" | "favorites" | "playlists" | "genres";
// state + effect:
const [genres, setGenres] = useState<GenreSummary[]>([]);
useEffect(() => { if (tab === "genres") listGenres().then(setGenres).catch(() => setGenres([])); }, [tab]);
// render when tab === "genres":
{tab === "genres" && (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 12 }}>
    {genres.map((g) => (
      <button key={g.id} onClick={() => navigate(`/genre/${g.id}`)}
        style={{ textAlign: "left", padding: "0.9rem", borderRadius: 12, cursor: "pointer",
                 background: g.accentColor ? `linear-gradient(135deg, ${g.accentColor}, var(--color-panel))` : "var(--color-active)",
                 border: "1px solid var(--color-border)", color: "var(--color-ink)" }}>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: "1.05rem" }}>{g.name}</div>
        <div style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>{g.songCount} songs</div>
      </button>
    ))}
  </div>
)}
```
Import `listGenres`, `type GenreSummary`, `navigate`. Add `"genres"` to the `(["all","favorites","playlists"] as Tab[])` array → `(["all","favorites","playlists","genres"] as Tab[])`. Map `route.name === "genres"` → `initialTab="genres"` in `App.tsx`.

- [ ] **Step 4: Typecheck + build the SPA**

Run: `cd ui && npx tsc --noEmit && npm run test -- --run`
Expected: no type errors; existing tests still pass. (`GenreEditor` import will fail typecheck until Task 18 — do Task 17 Step 4 verification after Task 18, or stub `GenreEditor` first. Recommended: implement Task 18 immediately, then run this check.)

- [ ] **Step 5: Commit** (after Task 18 compiles)

```bash
git add ui/src/GenreDetail.tsx ui/src/App.tsx ui/src/Library.tsx
git commit -m "feat(ui): minimal genre detail page + Genres tab hosting the editor"
```

---

## Task 18: Genre background editor modal + no-AI-in-UI test

**Files:**
- Create: `ui/src/GenreEditor.tsx`, `ui/src/GenreEditor.test.tsx`

**Interfaces:**
- Consumes: `GenreDetail` type, `uploadFanart`, `generateFanart`, `getFanartMeta`, `patchGenre`, `fanartUrl`, `Fanart`, `Icon`.
- Produces: `GenreEditor({ detail, imageGenEnabled, onClose, onChanged })` — modal with large preview (active background), a gallery grid (each ready image clickable to set background; a star toggle to set/clear hero; generating tiles show a spinner; failed tiles show a retry hint; an Upload tile), a genre-name field with Save, and — **only when `imageGenEnabled` is true** — a "Generate image" panel (prompt textarea + Generate button) that calls `generateFanart` then polls `getFanartMeta` until `ready`/`failed`, calling `onChanged` to refresh.

- [ ] **Step 1: Write the failing test** — `GenreEditor.test.tsx`. The critical invariant test: with `imageGenEnabled={false}` the DOM contains **no** prompt textarea and no "Generate" text; with `true` it does.

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GenreEditor } from "./GenreEditor";
import type { GenreDetail } from "./api";

afterEach(cleanup);

const detail: GenreDetail = {
  genre: { id: "g1", name: "Jazz", songCount: 3, accentColor: "#334455" },
  songs: [],
  fanart: [],
  backgroundId: "",
  heroId: "",
};

describe("GenreEditor no-AI-in-UI invariant", () => {
  it("hides the prompt and Generate control when generation is disabled", () => {
    render(<GenreEditor detail={detail} imageGenEnabled={false} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.queryByPlaceholderText(/describe the image/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
    expect(document.body.textContent || "").not.toMatch(/generate/i);
  });

  it("shows the generate panel only when enabled", () => {
    render(<GenreEditor detail={detail} imageGenEnabled={true} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.getByPlaceholderText(/describe the image/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /generate/i })).toBeTruthy();
  });
});
```

Check `ui/package.json` for `@testing-library/react` + `jsdom`; if the project's Vitest env isn't already `jsdom`, add `// @vitest-environment jsdom` at the top of the test file. (Grep an existing `*.test.tsx`; if none exists, confirm `jsdom` is a devDependency — the ported test needs it. If absent, `npm i -D @testing-library/react jsdom` and set the env comment.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run GenreEditor.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `GenreEditor.tsx`** — reuse `TagEditor`'s modal shell styling. Key rule: the entire generate panel is wrapped in `{imageGenEnabled && (…)}` so nothing AI-related renders otherwise.

```tsx
import { useState } from "react";
import { uploadFanart, generateFanart, getFanartMeta, patchGenre, type GenreDetail, type Fanart } from "./api";
import { fanartUrl } from "./fanart";
import { Icon } from "./Icon";

type Props = { detail: GenreDetail; imageGenEnabled: boolean; onClose: () => void; onChanged: () => void };

export function GenreEditor({ detail, imageGenEnabled, onClose, onChanged }: Props) {
  const [name, setName] = useState(detail.genre.name);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const genreId = detail.genre.id;

  const refresh = () => onChanged();

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    try { await uploadFanart("genre", genreId, file); refresh(); }
    catch { setErr("Upload failed"); }
    e.target.value = "";
  };

  const setBackground = async (fa: Fanart) => {
    if (fa.status !== "ready") return;
    try { await patchGenre(genreId, { backgroundFanartId: fa.id }); refresh(); }
    catch { setErr("Could not set background"); }
  };

  const toggleHero = async (fa: Fanart) => {
    if (fa.status !== "ready") return;
    try { await patchGenre(genreId, fa.isHero ? { clearHero: fa.id } : { heroFanartId: fa.id }); refresh(); }
    catch { setErr("Could not update hero"); }
  };

  const saveName = async () => {
    if (!name.trim()) return;
    try { await patchGenre(genreId, { name: name.trim() }); refresh(); }
    catch { setErr("Rename failed"); }
  };

  const pollUntilDone = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const fa = await getFanartMeta(id);
      if (fa.status !== "generating") { refresh(); if (fa.status === "failed") setErr(fa.error || "Generation failed"); return; }
      await new Promise((r) => setTimeout(r, 1500));
      refresh();
    }
  };

  const onGenerate = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setErr(null);
    try {
      const { id } = await generateFanart(prompt.trim(), "genre", genreId);
      setPrompt("");
      refresh();
      void pollUntilDone(id);
    } catch { setErr("Could not start generation"); }
    finally { setBusy(false); }
  };

  const active = detail.fanart.find((f) => f.id === detail.backgroundId);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", padding: "1rem", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(680px,100%)", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "1.25rem", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Edit genre</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.2rem" }}>×</button>
        </div>

        <div style={{ height: 200, borderRadius: 12, marginBottom: "1rem", background: active ? `linear-gradient(180deg,rgba(0,0,0,0.05),rgba(0,0,0,0.55)), url(${fanartUrl(active.id, "hero")}) center/cover` : "var(--color-active)", display: "grid", placeItems: "center" }}>
          {!active && <span style={{ color: "var(--color-muted)" }}>No background yet</span>}
        </div>

        <label style={{ display: "block", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-muted)", marginBottom: 4 }}>Name</label>
        <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, background: "var(--color-bg)", color: "var(--color-ink)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit" }} />
          <button onClick={saveName} style={{ background: "var(--color-active)", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>Save</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 10, marginBottom: "1rem" }}>
          {detail.fanart.map((fa) => (
            <div key={fa.id} style={{ position: "relative", aspectRatio: "16/9", borderRadius: 10, overflow: "hidden", border: fa.id === detail.backgroundId ? "2px solid var(--color-accent-strong)" : "1px solid var(--color-border)", background: "var(--color-active)" }}>
              {fa.status === "ready" ? (
                <button onClick={() => setBackground(fa)} aria-label="Set as background" style={{ width: "100%", height: "100%", border: "none", padding: 0, cursor: "pointer", background: `url(${fanartUrl(fa.id, "card")}) center/cover` }} />
              ) : (
                <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--color-muted)", fontSize: "0.75rem" }}>
                  {fa.status === "generating" ? <Icon name="spinner" size="20px" /> : "failed"}
                </div>
              )}
              {fa.status === "ready" && (
                <button onClick={() => toggleHero(fa)} aria-label={fa.isHero ? "Unstar hero" : "Star as hero"} style={{ position: "absolute", top: 4, right: 4, background: "rgba(0,0,0,0.5)", border: "none", borderRadius: 6, cursor: "pointer", color: fa.isHero ? "var(--color-accent-strong)" : "#fff", display: "grid", placeItems: "center", padding: 2 }}>
                  <Icon name={fa.isHero ? "starFilled" : "star"} size="16px" />
                </button>
              )}
            </div>
          ))}
          <label style={{ aspectRatio: "16/9", borderRadius: 10, border: "1px dashed var(--color-border)", display: "grid", placeItems: "center", cursor: "pointer", color: "var(--color-accent-strong)" }}>
            <span style={{ display: "grid", placeItems: "center", gap: 4 }}><Icon name="upload" size="18px" /><span style={{ fontSize: "0.75rem" }}>Upload</span></span>
            <input type="file" accept="image/jpeg,image/png" onChange={onUpload} style={{ display: "none" }} />
          </label>
        </div>

        {imageGenEnabled && (
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "1rem" }}>
            <label style={{ display: "block", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-muted)", marginBottom: 4 }}>Generate image</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image you want…" rows={3}
              style={{ width: "100%", background: "var(--color-bg)", color: "var(--color-ink)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit", resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={onGenerate} disabled={busy || !prompt.trim()} style={{ background: "var(--color-accent)", border: "none", color: "#fff", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>{busy ? "Starting…" : "Generate"}</button>
            </div>
          </div>
        )}

        {err && <p style={{ color: "var(--color-accent-strong)", marginTop: "0.75rem" }}>{err}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass + full FE suite + typecheck**

Run: `cd ui && npm run test -- --run GenreEditor.test.tsx && npx tsc --noEmit && npm run test -- --run`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/GenreEditor.tsx ui/src/GenreEditor.test.tsx
git commit -m "feat(ui): genre background editor modal; generate panel gated behind imageGenEnabled (no-AI-in-UI test)"
```

---

## Task 19: Build, run, and validate end-to-end with Playwright

**Files:** none (validation task). Fold any fixes discovered here into the relevant task's files and commit with a `fix:` message.

**Interfaces:** Consumes the whole running app.

- [ ] **Step 1: Full build**

Run: `make fe-build && (cd backend && CGO_ENABLED=0 go build -o ../bin/music ./cmd/music)`
Expected: SPA builds into `backend/web/dist`; binary builds clean.

- [ ] **Step 2: Start the app (no BFL key — degrade path)**

Run (background): `BACKEND_SESSION_SECRET=devsecret BACKEND_AUTH_MODE=dev BACKEND_DB_PATH=/tmp/music-p5.db BACKEND_MEDIA_DIR=/tmp/music-p5-media BACKEND_LISTEN_ADDR=:8099 ./bin/music`
Seed at least one song with a genre first (upload an MP3 via the UI, or reuse an existing test DB). Confirm `GET http://localhost:8099/api/health` returns ok.

- [ ] **Step 3: Playwright — Upload → active background → accent → star hero (authenticated, dev mode)**

Using Playwright MCP browser tools against `http://localhost:8099`:
1. `browser_navigate` to `/genres`; click a genre → `/genre/{id}`.
2. Click **Edit**; in the modal use the Upload tile (`browser_file_upload`) with a real JPEG/PNG.
3. Assert the uploaded tile appears; click it to set background; assert the large preview now shows an image and the tile has the accent border.
4. Reload the genre page; assert the header background renders the image (not the fallback initial) — take a screenshot.
5. Star the image as hero; assert the star turns filled.
6. **Assert the generate panel is ABSENT** (no "Generate" button / no prompt textarea) since no BFL key is set — `browser_snapshot` and check text.

- [ ] **Step 4: Playwright — sized variants actually differ**

Use `browser_evaluate` (or `browser_network_request`) to fetch the active fanart at two sizes and compare byte lengths:
```js
async () => {
  const id = /* backgroundId from the page or /api/genres/{id} */;
  const [t, h] = await Promise.all([
    fetch(`/api/fanart/${id}?size=thumb`).then(r => r.arrayBuffer()),
    fetch(`/api/fanart/${id}?size=hero`).then(r => r.arrayBuffer()),
  ]);
  return { thumb: t.byteLength, hero: h.byteLength, differ: t.byteLength !== h.byteLength };
}
```
Expected: `differ === true` and `thumb < hero`.

- [ ] **Step 5: Playwright — anonymous never sees AI/prompt**

Restart the app with `BACKEND_AUTH_MODE=oidc` (anonymous) **and** a dummy `BACKEND_BFL_API_KEY=x` set (to prove the flag is auth-gated, not just key-gated):
1. Navigate to `/genre/{id}`; assert there is **no Edit button**.
2. `browser_snapshot`; assert the page text contains no "Generate", no "prompt", no AI reference.
3. `browser_evaluate`: `await fetch('/api/auth/session').then(r=>r.json())` → assert `imageGenEnabled === false`.
4. `browser_evaluate`: fetch `/api/genres/{id}` → assert no `prompt`/`model`/`image_path` keys anywhere in the JSON string.

- [ ] **Step 6: Backend generation state machine (already unit-tested; smoke the key-present wiring)**

Restart with `BACKEND_AUTH_MODE=dev` and a **fake** BFL base URL that isn't reachable (`BACKEND_BFL_API_KEY=x BACKEND_BFL_BASE_URL=http://127.0.0.1:1/v1 BACKEND_BFL_POLL_TIMEOUT=3s`). In the editor (now showing the generate panel), submit a prompt; assert a generating tile appears, then resolves to a **failed** tile within a few seconds (connection refused → `MarkFanartFailed`) — proving the async path and graceful degradation without a live key. Screenshot both states.

- [ ] **Step 7: Record results.** Stop the app. Note screenshots/paths in the PR description. If anything failed, fix in the owning task's files, re-run the relevant tests, and commit `fix:`.

- [ ] **Step 8: Commit any fixes**

```bash
git add -A && git commit -m "fix: address Playwright validation findings for Phase 5 imagery"
```

---

## Task 20: Pre-merge code review, then PR

**Files:** none (process task).

- [ ] **Step 1: Full green gate**

Run: `cd backend && go vet ./... && CGO_ENABLED=0 go test ./... && cd ../ui && npx tsc --noEmit && npm run test -- --run`
Expected: all pass.

- [ ] **Step 2: Dispatch a generic code-review agent** over the branch diff vs `master`. Focus areas (from the brief): write-endpoint auth gating; media sandboxing (fanart paths via `media.Store`, no `..`/absolute/symlink escape); **the no-AI-in-UI invariant at the payload level** (no `prompt`/`model`/error text served to anonymous, feature flag auth-gated); BFL error/timeout/moderation handling and the key-absent degrade path; migration squash correctness (no `0002_*.sql`); imagescale variant correctness + cache-path sandboxing. Provide the agent the diff (`git diff master...HEAD`).

- [ ] **Step 3: Triage & fix findings** using superpowers:receiving-code-review (verify before implementing). Commit fixes; re-run Step 1.

- [ ] **Step 4: Confirm the review agent left no stray worktree/branch state** — `git worktree list` and `git status` must show only this worktree on `feat/phase-5-imagery-fanart-generation-imagescale`, clean.

- [ ] **Step 5: Push & open the PR against THIS repo's `master`** (never an upstream — this repo's `origin` is `git@github.com:trick77/music.git`, the user's own repo, so no fork-target confirmation is needed, but still target `trick77/music:master`).

```bash
git push -u origin feat/phase-5-imagery-fanart-generation-imagescale
gh pr create --repo trick77/music --base master \
  --title "feat: Phase 5 — imagery, fanart upload/assign, AI generation & image sizing" \
  --body "<summary of tasks, validation screenshots, and the no-AI-in-UI + degrade-path evidence>"
```

- [ ] **Step 6: STOP — do not merge.** Await the user's explicit go-ahead before merging. After merge (with go-ahead), remove the worktree via `ExitWorktree`.

---

## Self-Review (against the Phase 5 brief)

- **Fanart persistence + upload/assign (§8)** → Tasks 5, 6, 9, 10 (upload, gallery, active background, hero, accent). ✔
- **Reuse Phase 4 storeUploadedCover/imageutil pipeline** → Task 7 extracts `bufferProbeImage`; Task 9 reuses it (validation shared, fanart gets its own row). ✔
- **Endpoints POST /api/fanart (+assign), PATCH /api/genres/{id}, GET /api/fanart/{id} (public), genre-gallery read** → Tasks 9, 10. ✔
- **Graceful no-image fallback** → GenreDetail gradient+initial fallback (Task 17); editor "No background yet" (Task 18). ✔
- **AI generation §8a — port loom BFL verbatim, async submit→poll→download, moderated/timeout handling, optional input_image** → Task 2 (verbatim port incl. `InputImages`), Task 11 (async state machine). ✔
- **Config BFL vars (loom-identical) + .env.example** → Tasks 1, 14. ✔
- **POST /api/fanart/generate returns id in generating state; client polls GET /api/fanart/{id}** → Task 11 (202 + id); Task 9 (`?meta=1` status); Task 15/18 (polling). ✔ *(polling uses `?meta=1` on the same path — documented deviation: the bytes route serves images, the meta view serves status; both live under `GET /api/fanart/{id}`.)*
- **Store prompt+model+seed** → Task 5 columns; Task 6/11 persist them **server-only** (never serialized). ✔
- **Generation available only when BFL key set; else Upload-only** → Task 11 (404), Task 12 (flag), Task 18 (panel gated). ✔
- **Image sizing §15a — port loom imagescale, sized variants for cover + fanart, size param** → Tasks 3, 8, 9 (covers + fanart honour `?size=`). ✔
- **Genre background editor frontend (§8) with Icon/Menu** → Tasks 17, 18 (uses `Icon`). ✔
- **No-AI-in-UI invariant guarded in a test** → Task 18 FE test + Tasks 6/9/11 payload-scrub tests + Task 19 anonymous Playwright checks. ✔
- **Every write endpoint auth-gated; anonymous read-only; media sandboxed; secrets via env; uploads validated** → Tasks 9, 10, 11 (auth checks), `media.Store` throughout, Task 20 review. ✔
- **Migrations squashed (no 0002)** → Task 5. ✔
- **Validate with Playwright; code review before merge; PR to this repo's master; merge only on go-ahead** → Tasks 19, 20. ✔
- **Deferred (NOT built): immersive home/detail/player/mobile, MediaSession/PWA, resume, play-counting/Top-Ten, OIDC** → not in any task. ✔

**Type consistency check:** `Fanart` fields (`id,kind,genreId,status,caption,isActive,isHero,width,height` + server-only `ImagePath/Prompt/Model/ErrorMsg/Seed`) are identical across Task 6 (Go), Task 9 (`fanartMeta`), and Task 15 (TS). `getGenreExtended` response shape `{genre,songs,fanart,backgroundId,heroId}` matches `GenreDetail` in Task 15 and consumers in Tasks 17/18. `patchGenre` body `{name?,backgroundFanartId?,heroFanartId?,clearHero?}` matches Task 10 handler and Task 15 client. Sizes `thumb/card/hero` = `160/480/1600` consistent across Tasks 8, 15, 19.
