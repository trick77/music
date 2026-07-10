# Phase 10 — Studio cover-art image generation — Design

## Context

Phase 9 shipped **Studio** (`/studio`): it turns a named reference song into three ephemeral
outputs — a Suno **Style** prompt, editable original **Lyrics**, and an epoch-correct
**cover-art prompt** (design spec §39). The cover-art card is text-only; generating the actual
image was explicitly deferred — the card note reads "→ image generator (coming later)".

This phase makes the cover-art prompt produce a **real image** using the image-generation
infrastructure already wired for fanart (`imagegen.Provider` → the BFL FLUX models), and lets an
authenticated user pick the model, view the image, and download it. Anonymous / key-less instances
see nothing new.

The need: Studio's cover-art prompt is currently a dead end — the user has to copy it into a
separate tool. Closing the loop in-app makes Studio a complete "song → Suno + cover" workflow.

## Goals / Non-goals

**Goals**
- Generate a square album-cover image from the (editable) cover-art prompt, synchronously.
- Let the user choose among three FLUX.2 model variants.
- View the result inline and download it.
- Persist each generated image (accumulating), reusing the fanart storage/serving machinery.
- Gate the whole affordance on `studioEnabled && imageGenEnabled`.
- Keep the backend test suite free of live BFL calls (reuse the fake-provider harness).

**Non-goals**
- No async 202/poll flow (fanart's model) — deliberately synchronous (see Decisions).
- No gallery / listing of past cover art (Studio has none; images are addressable only by id).
- No seed display or reproducibility affordance.
- No change to the existing fanart, genre, or hero domains.

## Owner decisions (settled during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Sync vs async | **Synchronous** | Smallest surface; `imagegen.Provider.Generate()` already blocks/polls BFL internally. Cheap to rip out and swap for async later if it proves inadequate. |
| Persistence | **Persisted, accumulating** (row + PNG per generate) | Owner preference; mirrors fanart's accumulation. |
| Dimensions | **1024×1024 PNG** | Matches the prompt's "square album composition". |
| Prompt editable | **Yes** | Extends the Phase 9 editable-lyrics precedent. |
| Model picker | **3 FLUX.2 variants**, seed random & hidden | Owner wants to choose the variant; seed is meaningless in a non-reproducible UI. |
| Table | **Dedicated `studio_coverart`** (not `fanart`) | Keeps Studio independent of the genre/hero library domain (as the code documents); avoids weakening the `fanart` `kind` CHECK; no leakage into genre galleries / Home hero; trivially droppable. |

## Models exposed

BFL submits to `POST /v1/<model>` — the model is a URL path segment already supported as a
per-request override (`imagegen.GenerateRequest.Model` → `BFLClient.effectiveModel`). No client
change is needed. Three variants:

| Model ID | UI label | Notes |
|---|---|---|
| `flux-2-klein-4b` | `Fast · flux-2-klein-4b` | current app default (`BACKEND_BFL_MODEL`); UI default selection |
| `flux-2-flex` | `Balanced (typography) · flux-2-flex` | text-on-cover friendly (repo already earmarks flex for typography) |
| `flux-2-pro` | `Best quality · flux-2-pro` | BFL's recommended tier |

The client-supplied `model` is validated against this **allowlist** (it becomes a URL path
segment — untrusted strings must never be forwarded). Empty → falls back to `cfg.BFLModel`.

## Architecture

Two isolated units, plus thin wiring:

1. **Persistence unit** — `library.Repo` methods over a dedicated `studio_coverart` table.
   Input: id, image path, prompt, model, seed, dimensions. Output: a `StudioCoverArt` row (with
   server-only fields). Depends only on the DB. Mirrors the fanart repo shape.

2. **HTTP unit** — two handlers on the existing `songHandlers` (which already owns `repo`,
   `media`, `imageGen`, `cfg`). `songHandlers` is the natural home: persistence needs the store,
   and it already carries the injected `imagegen.Provider` used by the fanart tests, so the fake
   provider is reused with **no new injection point**.

3. **Wiring** — register the two routes in `server.go` inside the existing song-routes block.

### Data flow (POST)

```
Browser (StudioPage / CoverArtCard)
  │  POST /api/studio/coverart { prompt, model }
  ▼
songHandlers.postStudioCoverArt   (synchronous)
  ├─ gate: authenticated? studioEnabled && imageGenEnabled? imageGen != nil?
  ├─ validate prompt (non-empty, ≤ imagegen.MaxPromptRunes)
  ├─ resolve model (empty → cfg.BFLModel; else must be in allowlist)
  ├─ seed = randomSeed();  id = library.NewID()
  ├─ imageGen.Generate(ctx, {Prompt, 1024×1024, png, Seed, Model})   ← blocks ~15–40s
  │     └─ on error → 502, no row written, prompt/detail NOT leaked
  ├─ writeBytes(media, "coverart/"+id+".png", res.Bytes)
  ├─ w,h = imageutil.Probe(res.Bytes)  (fallback res.Width/Height)
  ├─ repo.CreateStudioCoverArt(id, path, prompt, model, seed, w, h)   ← status 'ready'
  └─ 200 { id, status:"ready", width, height }
       (prompt / model / seed live only in the DB)
```

### Data flow (GET)

```
Browser  <img src="/api/studio/coverart/{id}">  /  <a href=... download>
  ▼
songHandlers.getStudioCoverArt
  ├─ auth-gate (403 if anonymous — Studio is authed-only)
  ├─ repo.GetStudioCoverArt(id);  nil or non-ready → 404
  └─ serveSizedImage(w, r, media, row.ImagePath)   ← reused; full size
```

## Components (detail)

### 1. Migration — `backend/internal/store/migrations/0001_init.sql`

Per the pre-launch squash-migrations decision (this repo has no live instance), the new table is
folded into `0001_init.sql`, not a new `NNNN_` migration.

```sql
CREATE TABLE studio_coverart (
    id         TEXT PRIMARY KEY,
    image_path TEXT NOT NULL,
    prompt     TEXT,                       -- server-only, never served to clients
    model      TEXT,                       -- server-only
    seed       INTEGER,                    -- server-only
    width      INTEGER NOT NULL DEFAULT 0,
    height     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating','ready','failed')),
    error      TEXT,                       -- server-only
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The sync path only ever writes `'ready'`; `generating`/`failed` remain in the CHECK so a future
async swap needs no schema change. No `genre_id` / `is_active` / `is_hero` — this domain has none.

### 2. Repo — new `backend/internal/library/studio_coverart.go`

Mirrors the fanart repo shape (`fanart.go`), reusing `NewID()`, `nullIfEmpty`, and the `scan*`
pattern. Server-only fields carry no JSON tags leaking them.

```go
type StudioCoverArt struct {
    ID            string
    Status        string
    Width, Height int
    ImagePath     string // server-only
    Prompt        string // server-only
    Model         string // server-only
    ErrorMsg      string // server-only
    Seed          *int64 // server-only
}

// CreateStudioCoverArt inserts a ready row recording the (server-only) prompt/model/seed.
func (r *Repo) CreateStudioCoverArt(ctx context.Context, id, imagePath, prompt, model string, seed *int64, width, height int) error

// GetStudioCoverArt returns (nil, nil) when the row is absent, like GetFanart.
func (r *Repo) GetStudioCoverArt(ctx context.Context, id string) (*StudioCoverArt, error)
```

### 3. Handler — new `backend/internal/httpapi/studio_coverart.go` (methods on `songHandlers`)

- **`POST /api/studio/coverart` → `postStudioCoverArt`** (synchronous):
  1. `identify(h.cfg, r).Authenticated` else 403.
  2. `cfg.StudioEnabled() && cfg.ImageGenEnabled()` else 404; `h.imageGen == nil` → 404.
     (Both-keys gate; mirrors `studioHandlers.guard` + fanart's imageGen check.)
  3. Decode `{prompt, model}` via `http.MaxBytesReader(w, r.Body, 1<<20)`. `prompt` non-empty and
     `≤ imagegen.MaxPromptRunes` else 400.
  4. Resolve `model`: empty → `cfg.BFLModel`; else must be one of the allowlist, else 400.
  5. `seed := randomSeed()` (reuse the helper in `fanart_generate.go`); `id := library.NewID()`.
  6. `h.imageGen.Generate(ctx, imagegen.GenerateRequest{Prompt: prompt, Width: 1024, Height: 1024,
     OutputFormat: "png", Seed: &seed, Model: model})` on a context bounded by
     `cfg.BFLPollTimeout + 30s`.
  7. On error → `502` with a generic message (`"cover art generation failed"`); never leak the
     prompt or BFL detail; no row inserted (sync ⇒ no stranded rows, no reaper needed).
  8. On success → `relPath := "coverart/" + id + ".png"`; `writeBytes(h.media, relPath, res.Bytes)`;
     `imageutil.Probe` for w/h (fallback `res.Width/Height`); `CreateStudioCoverArt(...)`;
     respond `200 { id, status:"ready", width, height }`.

- **`GET /api/studio/coverart/{id}` → `getStudioCoverArt`**: `GetStudioCoverArt`; nil or
  `status != "ready"` → 404; **auth-gate** (403 if not authenticated — unlike public fanart
  backgrounds, Studio is authed-only); else `serveSizedImage(w, r, h.media, row.ImagePath)`.

### 4. Wiring — `backend/internal/httpapi/server.go`

Register the two routes next to the fanart routes (~line 139), inside the
`st != nil && cfg.MediaDir != ""` block. No signature changes — the existing `gen` parameter
already flows into `songHandlers.imageGen`.

### 5. Frontend

- **`ui/src/api.ts`**
  - `export const COVER_ART_MODELS = [{ id, label }, …]` (the three above).
  - `generateStudioCoverArt(prompt, model): Promise<{ id: string; status: string; width: number; height: number }>` → `POST /api/studio/coverart`.
  - `studioCoverArtUrl(id) => \`/api/studio/coverart/${id}\`` (image `src` / download `href`).

- **`ui/src/StudioPage.tsx`**
  - `StudioPage` gains an `imageGenEnabled?: boolean` prop.
  - The cover-art `ResultCard` becomes **editable** (`onChange` → `setResult({ ...result, coverArtPrompt })`); drop the "(coming later)" note.
  - Extract and **export** a `CoverArtCard` component (mirroring how `ResultCard` is exported for
    tests), rendered only when `imageGenEnabled`:
    - a model `<select>` (new — no select exists in the app; styled with `--color-panel`,
      `--color-border`, `--radius-ui`, `--color-ink`), default `flux-2-klein-4b`;
    - a **Generate cover art** button (→ **Regenerate** once an image exists) calling
      `generateStudioCoverArt(editedPrompt, selectedModel)`;
    - on success an `<img src={studioCoverArtUrl(id)}>` + a **Download** anchor
      (`<a href={studioCoverArtUrl(id)} download="cover.png">` with the existing `download` glyph);
    - reuse the existing `Spinner` for the busy state and the app's error-text style for failures.
  - Reset cover-art state (image / error / busy) whenever a new song is generated.

- **`ui/src/App.tsx`** — pass `imageGenEnabled={!!session?.imageGenEnabled}` into `<StudioPage />`.

## Error handling

- **Generation failure / moderation:** the BFL client already maps moderation and timeout to
  errors; the handler returns a generic `502` and inserts no row. The prompt and BFL detail never
  reach the client. The UI shows a generic failure message and lets the user retry.
- **Bad model:** `400` before any BFL call.
- **Disabled instance:** `404` (indistinguishable from "route absent"), matching the presence/
  absence gating convention (no lock icons).
- **Anonymous image fetch:** `403`.
- **Server restart mid-request:** the sync path writes the row only on success, so no row is
  stranded in `generating`; no reaper is required.

## Testing

- **Backend** (`make test` / `go test ./...` — must stay green; the known-flaky
  `TestHomeFeed_recentNewestFirstWithLimit` fails on master too and is unrelated): new
  `backend/internal/httpapi/studio_coverart_test.go` built on the existing
  `newFanartServer(t, gen, onGen)` harness + `fakeProvider` (no live BFL). Cases:
  - sync generate → `200` + a `studio_coverart` row persisted with server-only prompt/model/seed;
  - the response body does **not** contain the prompt;
  - `404` when `imageGen` is nil; `404` when Studio is not enabled;
  - `400` on a model outside the allowlist;
  - `GET /api/studio/coverart/{id}` returns the PNG bytes, and `403` for anonymous.
- **Frontend** (`make fe-test`: `tsc` clean + vitest green): extend `ui/src/Studio.test.tsx` to
  render the exported `CoverArtCard` standalone — model options + Generate button present when
  enabled; nothing shown when `imageGenEnabled` is false.
- **Playwright e2e** against the running app (docker-dev with keys, or a stubbed provider):
  (a) with neither / only one key the "Generate cover art" affordance is **invisible**;
  (b) with both keys, a prompt generates and an image displays.

## Conventions

Loom design tokens + self-hosted Anthropic fonts; English only; no AI branding/wordmark in
anonymous-visible copy (this card is authed-only regardless); presence/absence gating (no lock
icons).

## Assumed defaults (flag if wrong)

- Model-picker labels show both a descriptive tag and the raw ID; default selection
  `flux-2-klein-4b` (the app's configured default). The instance's `BACKEND_BFL_MODEL` is **not**
  exposed via the session — keeps the change self-contained.
- No `failed` rows persisted on error; accumulation applies to successes only.
