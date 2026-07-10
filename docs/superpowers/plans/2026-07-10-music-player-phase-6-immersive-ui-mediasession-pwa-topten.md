# Music Player Phase 6 — Immersive UI, MediaSession, PWA, Top-Ten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — the frontend tasks share a player store and are best kept in one context). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real play counting + a deterministic Top-Ten, add the home feed and search endpoints, and build the immersive image-forward frontend (home hero + genre chapters + unified detail template + full-screen/mini player) with MediaSession, a PWA manifest + service worker, and client-side resume — all validated against real generated fanart.

**Architecture:** Backend adds four read/write endpoints over the already-present `plays` table (no schema change needed) plus home/search aggregators, following the existing `songHandlers`/`library.Repo` patterns. Frontend lifts playback out of `App.tsx`'s god-component into a single `player` store module (React hook + module singleton) that owns the `<audio>` element, queue, history, MediaSession, resume persistence, and qualified-play reporting; new immersive screens (Home, unified Detail, full-screen player, mini-player, search, rail/tab-bar) consume that store. PWA scaffolding lives in `ui/public/` and `main.tsx`.

**Tech Stack:** Go 1.25 stdlib `net/http`, `ncruces/go-sqlite3`; React 19 + TS + Vite 8 + Tailwind v4 (used as CSS-variable tokens in inline styles); Vitest; Playwright MCP for live validation; BFL/FLUX for real fanart.

## Global Constraints

- Module `github.com/trick77/music`, Go 1.25, `CGO_ENABLED=0`, stdlib `net/http` (Go 1.22 method routing), no framework.
- Pure-Go SQLite `ncruces/go-sqlite3` v0.23.3 only. One SQLite file.
- **Migrations squashed pre-launch:** fold any new columns into `backend/internal/store/migrations/0001_init.sql`. Do NOT add `0002_*.sql`. (This plan needs no new columns — the `plays` table already has `id, song_id, played_at`.)
- `.yaml` not `.yml`. English only in code/docs/comments/UI copy.
- **No AI branding/wordmark** in any anonymous-visible UI. Fanart is presented as ordinary finished art; anonymous visitors never see prompts, "generate", or any AI reference. Server-only fanart fields (`image_path`, `prompt`, `model`, `seed`, `error`) stay `json:"-"` / auth-gated.
- **Every write endpoint gated to the authenticated role** via `identify(h.cfg, r).Authenticated`, with the SINGLE documented exception `POST /api/songs/{id}/play` (spec §12 lists it as anonymous-OK — record plays is a public write; call this out in code comment + PR description so review does not flag it).
- Media/image access sandboxed under the media root (existing `media.Store` — reject `..`, absolute, symlink escape).
- Self-hosted only: no external CDNs/fonts/scripts. PWA assets self-hosted.
- Design tokens = loom `--*` CSS variables + self-hosted Anthropic fonts. Accent clay `#c6613f` / `#d97757`. Rank numbers use Anthropic Sans with `font-variant-numeric: tabular-nums`.
- Favorites stay localStorage-only (no server likes). The heart appears on rows / mini-player / full-screen player.
- TDD: failing test first, then minimal impl. Conventional commits. Never commit to `master`.
- Validate every runnable change with Playwright MCP against the running app.

---

## File Structure

**Backend (new/modified):**
- `backend/internal/library/plays.go` (create) — `RecordPlay`, `TopTen`, `TopTenEntry`.
- `backend/internal/library/plays_test.go` (create).
- `backend/internal/library/home.go` (create) — `HomeFeed`, `RecentSongs`, hero/chapter/playlist assembly helpers.
- `backend/internal/library/home_test.go` (create).
- `backend/internal/library/search.go` (create) — `Search`, `SearchResults`.
- `backend/internal/library/search_test.go` (create).
- `backend/internal/httpapi/plays.go` (create) — `postPlay` (public), `getTopTen`, in-memory throttle.
- `backend/internal/httpapi/plays_test.go` (create).
- `backend/internal/httpapi/home.go` (create) — `getHome`.
- `backend/internal/httpapi/home_test.go` (create).
- `backend/internal/httpapi/search.go` (create) — `getSearch`.
- `backend/internal/httpapi/search_test.go` (create).
- `backend/internal/httpapi/server.go` (modify) — register 4 routes.
- `backend/internal/httpapi/covers.go` (modify) — accept `?size=` on `GET /api/cover/{id}` (home grid needs sized covers).

**Frontend (new/modified):**
- `ui/src/player.ts` (create) — the player store: audio singleton, queue, history, play/pause/next/prev/seek, MediaSession, resume persistence, qualified-play reporting. Exports `usePlayer()` + imperative `player` singleton.
- `ui/src/player.test.ts` (create) — queue/history/next/prev, qualified-play threshold + once-per-session dedup, resume persist/restore (pure logic extracted so it's unit-testable without a real `<audio>`).
- `ui/src/resume.ts` (create) — localStorage persist/restore of `{songId, positionMs}` (mirrors `favorites.ts`).
- `ui/src/resume.test.ts` (create).
- `ui/src/api.ts` (modify) — add `getHome`, `getTopTen`, `search`, `reportPlay`, `coverUrl` size param; add types `HomeFeed`, `TopTenEntry`, `SearchResults`.
- `ui/src/api.test.ts` (create) — URL-builder tests for new helpers (pure).
- `ui/src/Home.tsx` (create) — immersive home (hero + Top-Ten chart + recently-added + genre chapters + playlists).
- `ui/src/Hero.tsx` (create) — reusable full-bleed hero component.
- `ui/src/Chapter.tsx` (create) — reusable immersive genre chapter component.
- `ui/src/Detail.tsx` (create) — unified immersive detail template (genre/artist/playlist): art top two-thirds over glass song-list panel.
- `ui/src/Player.tsx` (create) — full-screen player + docked mini-player (two presentations of the player store).
- `ui/src/Rail.tsx` (create) — slim icon-only rail (desktop) + mobile tab bar; no wordmark.
- `ui/src/Search.tsx` (create) — grouped search results (top result, songs, artists, genres, playlists).
- `ui/src/App.tsx` (modify) — mount Rail + Home + Detail + Player, delegate playback to `usePlayer()`, new routes.
- `ui/src/router.ts` (modify) — add `search`, `artist{id}` routes.
- `ui/src/cover.ts` (modify) — `coverUrl(id, size?)`.
- `ui/src/main.tsx` (modify) — register service worker.
- `ui/index.html` (modify) — manifest link, `theme-color`, `viewport-fit=cover`, apple-touch tags.
- `ui/public/manifest.webmanifest` (create).
- `ui/public/sw.js` (create) — minimal no-op-fetch service worker (installability only, no offline cache).
- `ui/public/icon-192.png`, `ui/public/icon-512.png`, `ui/public/icon-maskable-512.png` (create) — self-hosted PWA icons.
- `ui/src/index.css` (modify) — immersive utility styles (scrim, glass panel, tabular-nums rank, mobile tab bar).

---

## Task 1: Play recording + Top-Ten repo layer

**Files:**
- Create: `backend/internal/library/plays.go`
- Test: `backend/internal/library/plays_test.go`

**Interfaces:**
- Consumes: `library.Repo` (`NewRepo(db)`), existing test helper `openTestRepo` pattern (see `songs_test.go`/`playlists_test.go` for how library tests open a real store).
- Produces:
  - `func (r *Repo) RecordPlay(ctx, songID string) error` — inserts one `plays` row (`id=NewID()`), FK-validating song existence (return error if song absent).
  - `type TopTenEntry struct { Song; Plays int }` — embeds `Song`, adds `Plays int` (`json:"plays"`).
  - `func (r *Repo) TopTen(ctx) ([]TopTenEntry, error)` — top 10 by play count, deterministic order: `COUNT(*) DESC, lower(title) ASC, s.id ASC`.

- [ ] **Step 1: Write failing tests**

Mirror the existing library test setup (open a real store in a temp dir, `NewRepo(st.DB())`, seed songs via `repo.Create`). Cover:
1. `RecordPlay` inserts one row per call; `TopTen` counts them.
2. Ordering is by count DESC; a tie between two songs breaks by `lower(title)` then `id` — deterministic regardless of insertion order (insert plays in mixed order, assert stable ranking).
3. `TopTen` returns at most 10.
4. `RecordPlay` for a non-existent song returns an error and inserts nothing.
5. `TopTenEntry.Plays` carries the count and the embedded `Song` fields (title/artist) are hydrated.

- [ ] **Step 2: Run tests, verify they fail** — `cd backend && go test ./internal/library/ -run TestPlays -v` → FAIL (undefined `RecordPlay`/`TopTen`).

- [ ] **Step 3: Implement `plays.go`**

```go
package library

import "context"

// TopTenEntry is a song with its global play count for the chart.
type TopTenEntry struct {
	Song
	Plays int `json:"plays"`
}

// RecordPlay appends one qualified-play row for songID. It validates the song
// exists first so a bogus id can't create an orphan/counted row.
func (r *Repo) RecordPlay(ctx context.Context, songID string) error {
	var exists string
	if err := r.db.QueryRowContext(ctx, `SELECT id FROM songs WHERE id = ?`, songID).Scan(&exists); err != nil {
		return err // sql.ErrNoRows => unknown song
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO plays(id, song_id) VALUES(?, ?)`, NewID(), songID)
	return err
}

// TopTen returns the ten most-played songs. Ordering is fully deterministic —
// play count DESC, then case-folded title, then id — so ties never depend on
// row insertion order.
func (r *Repo) TopTen(ctx context.Context) ([]TopTenEntry, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+`
		JOIN plays p ON p.song_id = s.id
		GROUP BY s.id
		ORDER BY COUNT(p.id) DESC, lower(s.title) ASC, s.id ASC
		LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopTenEntry{}
	// scanSong reads the songSelect columns; the trailing COUNT is read separately
	// so we run a second lightweight query per row-free approach: instead, select
	// count inline. See implementation note below.
	_ = rows
	return out, nil
}
```

Implementation note — `scanSong` reads exactly the `songSelect` columns, so append the count as an extra selected column and scan it alongside. Rewrite `TopTen` to select `songSelect + ", COUNT(p.id) c"` and scan into a `Song` + `int`, then hydrate genres via `r.genresFor`. Final form:

```go
func (r *Repo) TopTen(ctx context.Context) ([]TopTenEntry, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+`, COUNT(p.id) AS play_count
		JOIN plays p ON p.song_id = s.id
		GROUP BY s.id
		ORDER BY play_count DESC, lower(s.title) ASC, s.id ASC
		LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopTenEntry{}
	for rows.Next() {
		var e TopTenEntry
		s, err := scanSongWithCount(rows, &e.Plays)
		if err != nil {
			return nil, err
		}
		e.Song = *s
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		g, err := r.genresFor(ctx, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Genres = g
	}
	return out, nil
}
```

Note `songSelect` is `SELECT ... FROM songs s JOIN artists a ...` — the extra column must be inserted before ` FROM`. Since `songSelect` bakes in `FROM`, define a dedicated select constant instead:

```go
const topTenSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.created_at,
	COUNT(p.id) AS play_count
	FROM songs s JOIN artists a ON a.id = s.artist_id JOIN plays p ON p.song_id = s.id
	GROUP BY s.id ORDER BY play_count DESC, lower(s.title) ASC, s.id ASC LIMIT 10`

// scanSongWithCount scans the standard song columns plus a trailing count.
func scanSongWithCount(row scanner, count *int) (*Song, error) {
	var s Song
	var album, cover sql.NullString
	var year, track sql.NullInt64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &s.CreatedAt, count); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.CoverArtID = cover.String
	s.Genres = []string{}
	return &s, nil
}
```
Use `topTenSelect` in the query (drop the earlier inline concat). Add `"database/sql"` import.

- [ ] **Step 4: Run tests, verify pass** — `go test ./internal/library/ -run TestPlays -v` → PASS.

- [ ] **Step 5: Commit** — `git add backend/internal/library/plays.go backend/internal/library/plays_test.go && git commit -m "feat(library): record plays and deterministic Top-Ten"`

---

## Task 2: Public play endpoint (throttled) + Top-Ten endpoint

**Files:**
- Create: `backend/internal/httpapi/plays.go`, `backend/internal/httpapi/plays_test.go`
- Modify: `backend/internal/httpapi/server.go` (register `POST /api/songs/{id}/play`, `GET /api/top-ten`)

**Interfaces:**
- Consumes: `library.Repo.RecordPlay`, `library.Repo.TopTen`, `songHandlers` struct, `identify`, `httpError`, `writeJSON`.
- Produces:
  - `func (h *songHandlers) postPlay(w, r)` — **public** (anonymous OK — the one documented exception). Records a play, applying a light in-memory per-(remoteIP, songID) throttle so refresh/replay within a cooldown window does not insert twice. Returns `204 No Content` on accept, `204` on throttled-skip too (idempotent-feeling), `404` for unknown song.
  - `func (h *songHandlers) getTopTen(w, r)` — public; `writeJSON({ "songs": [...TopTenEntry] })`.
  - A `playThrottle` type (mutex + `map[string]time.Time`) on `songHandlers` (field `throttle *playThrottle`), cooldown const `playCooldown = 30 * time.Second`.

- [ ] **Step 1: Write failing tests** (`plays_test.go`, using `testServer` from `songs_test.go`; upload the fixture to get a real song id):
1. `POST /api/songs/{id}/play` for a real song → `204`; `GET /api/top-ten` then lists it with `plays: 1`.
2. **Public**: same `POST` in `AuthModeOIDC` (anonymous) → `204` (NOT `403`) — this is the documented public-write exception. Contrast: a known write (`POST /api/fanart` or `PATCH /api/songs/{id}`) in OIDC → `403` (guards that only `/play` is public).
3. **Throttle/dedup**: two `POST .../play` for the same song from the same `RemoteAddr` within the window → exactly ONE `plays` row (assert `top-ten` count == 1). (Set the same `req.RemoteAddr` on both requests.)
4. Different `RemoteAddr` → both count (count == 2), proving throttle is per-client not global.
5. `POST /api/songs/unknown/play` → `404`.
6. `GET /api/top-ten` with no plays → `{"songs":[]}` (never null).

- [ ] **Step 2: Run, verify fail** — `go test ./internal/httpapi/ -run TestPlay -v` → FAIL.

- [ ] **Step 3: Implement** `plays.go`:

```go
package httpapi

import (
	"errors"
	"database/sql"
	"net"
	"net/http"
	"sync"
	"time"
)

const playCooldown = 30 * time.Second

// playThrottle rejects a repeated play of the same song from the same client
// within playCooldown. It is a light, in-memory guard against refresh/replay
// abuse — the primary once-per-listen dedup happens client-side (spec §9).
// No PII is persisted: keys live only in memory and are opportunistically swept.
type playThrottle struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

func newPlayThrottle() *playThrottle { return &playThrottle{seen: map[string]time.Time{}} }

// allow reports whether a play for key is accepted now, recording the time if so.
func (p *playThrottle) allow(key string, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if last, ok := p.seen[key]; ok && now.Sub(last) < playCooldown {
		return false
	}
	p.seen[key] = now
	// opportunistic sweep so the map can't grow unbounded
	if len(p.seen) > 4096 {
		for k, t := range p.seen {
			if now.Sub(t) >= playCooldown {
				delete(p.seen, k)
			}
		}
	}
	return true
}

func clientIP(r *http.Request) string {
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
		httpError(w, http.StatusInternalServerError, "get song")
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
			httpError(w, http.StatusInternalServerError, "record play")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *songHandlers) getTopTen(w http.ResponseWriter, r *http.Request) {
	entries, err := h.repo.TopTen(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "top ten")
		return
	}
	writeJSON(w, map[string]any{"songs": entries})
}
```

Wire in `server.go`: initialize `h.throttle = newPlayThrottle()` where `h` is built, and register:
```go
mux.HandleFunc("POST /api/songs/{id}/play", h.postPlay)
mux.HandleFunc("GET /api/top-ten", h.getTopTen)
```
Add `throttle *playThrottle` field to `songHandlers` in `songs.go`.

- [ ] **Step 4: Run, verify pass** — `go test ./internal/httpapi/ -run TestPlay -v` → PASS. Then full `go test ./...`.

- [ ] **Step 5: Commit** — `git commit -am "feat(api): public throttled POST /play and GET /top-ten"`

---

## Task 3: Home feed endpoint

**Files:**
- Create: `backend/internal/library/home.go`, `home_test.go`, `backend/internal/httpapi/home.go`, `home_test.go`
- Modify: `server.go` (register `GET /api/home`)

**Interfaces:**
- Consumes: existing `ListGenres`, `ListPlaylists` (playlist repo — confirm signature in `playlists.go`), `TopTen`, fanart queries (`GetFanart`, a new hero lookup), `List` (songs).
- Produces:
  - `type HomeFeed struct { Hero *HomeHero; TopTen []TopTenEntry; RecentlyAdded []Song; Genres []GenreChapter; Playlists []Playlist }`
  - `type HomeHero struct { FanartID, Kind, GenreID, Title, Subtitle, AccentColor string }` — from the starred `is_hero` fanart; nil when none.
  - `type GenreChapter struct { GenreSummary; BackgroundFanartID string; Songs []Song }` — top N (e.g. 8) songs per genre for the chapter rail, active-background fanart id, accent.
  - `func (r *Repo) HomeFeed(ctx, recentLimit, chapterSongLimit int) (*HomeFeed, error)`
  - `func (r *Repo) HeroFanart(ctx) (*Fanart, error)` — the single `is_hero=1 AND status='ready'` row or nil.
  - `func (r *Repo) RecentSongs(ctx, limit int) ([]Song, error)` — newest first, limited.

- [ ] **Step 1: Write failing tests** (library `home_test.go`):
1. Empty library → `HomeFeed` returns a non-nil struct with empty (non-nil) slices and `Hero == nil` (graceful degrade).
2. With songs → `RecentlyAdded` newest-first, honoring the limit.
3. With a genre that has an active-background fanart → that genre appears as a `GenreChapter` with `BackgroundFanartID` set and its songs (limited).
4. With a starred hero fanart → `Hero` populated with `FanartID` + `AccentColor` (from the hero's genre if genre-kind, else empty).
5. Genres with zero songs are omitted from chapters (they degrade out).

httpapi `home_test.go`:
6. `GET /api/home` → 200, JSON has keys `hero, topTen, recentlyAdded, genres, playlists`; slices never null.
7. **No-AI invariant:** the serialized home JSON contains no `prompt`, `model`, `seed`, `image_path`, `imagePath`, or `error` field anywhere (assert the raw body string excludes them) — hero/chapter reference fanart only by id.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** Assemble in `home.go` (reuse existing repo methods; add `HeroFanart`, `RecentSongs`, and a per-genre song fetch limited to N). In httpapi `home.go`, `getHome` calls `repo.HomeFeed(ctx, 12, 8)` and `writeJSON` a struct whose JSON tags are `hero,topTen,recentlyAdded,genres,playlists`. Hero/chapters expose only `fanartId`/`backgroundFanartId` + accent + display text — never server-only fields (those are already `json:"-"` on `Fanart`, but Home builds its own client structs, so just never copy them).

- [ ] **Step 4: Run, verify pass.** Full `go test ./...`.

- [ ] **Step 5: Commit** — `git commit -am "feat(api): GET /api/home immersive feed (hero, top-ten, recent, chapters, playlists)"`

---

## Task 4: Search endpoint

**Files:**
- Create: `backend/internal/library/search.go`, `search_test.go`, `backend/internal/httpapi/search.go`, `search_test.go`
- Modify: `server.go` (register `GET /api/search`)

**Interfaces:**
- Produces:
  - `type SearchResults struct { Top *SearchHit; Songs []Song; Artists []ArtistSummary; Genres []GenreSummary; Playlists []Playlist }`
  - `type SearchHit struct { Type string; ID string }` — the single best result (`type` ∈ song|artist|genre|playlist).
  - `func (r *Repo) Search(ctx, q string, limit int) (*SearchResults, error)` — case-insensitive substring (`LIKE '%'||?||'%' COLLATE NOCASE`, escape `%_`), each group limited; `Top` chosen by a simple precedence (exact title/name match > prefix match; song > artist > genre > playlist on ties).

- [ ] **Step 1: Write failing tests:**
1. Empty/blank `q` → all-empty (non-nil) result, `Top == nil`.
2. Query matching a song title → song in `Songs` and, if best, as `Top{type:"song"}`.
3. Case-insensitive: `"neon"` matches `"Neon Undertow"`.
4. `%`/`_` in query are treated literally (escaped), not as wildcards.
5. httpapi: `GET /api/search?q=neon` → 200 grouped JSON; `?q=` blank → empty groups; no server-only fanart fields leak.

- [ ] **Step 2–4:** fail → implement → pass. Use parameterized `LIKE` with an `ESCAPE '\'` clause and pre-escape `\ % _` in `q`.

- [ ] **Step 5: Commit** — `git commit -am "feat(api): GET /api/search grouped results"`

---

## Task 5: Sized cover variants

**Files:** Modify `backend/internal/httpapi/covers.go` (route `GET /api/cover/{id}` to `serveSizedImage`), add a test in `covers_test.go`.

- [ ] **Step 1:** Test `GET /api/cover/{id}?size=card` returns `image/jpeg` (scaled) and `?size=` absent returns original bytes, mirroring the fanart imageserve tests.
- [ ] **Step 2–4:** fail → route cover serving through `serveSizedImage(w, r, h.media, coverPath)` (same helper fanart uses) → pass.
- [ ] **Step 5: Commit** — `git commit -am "feat(api): sized cover variants (?size=thumb|card|hero)"`

---

## Task 6: PWA scaffolding (manifest + service worker + icons)

**Files:**
- Create: `ui/public/manifest.webmanifest`, `ui/public/sw.js`, `ui/public/icon-192.png`, `ui/public/icon-512.png`, `ui/public/icon-maskable-512.png`
- Modify: `ui/index.html`, `ui/src/main.tsx`

**Interfaces:**
- Produces: a registered service worker at root scope (`/sw.js`) and a served `/manifest.webmanifest`. SW does NOT cache (spec: no offline) — it exists solely for installability; a pass-through `fetch` handler is fine or omit fetch entirely.

- [ ] **Step 1:** `manifest.webmanifest` — `name`/`short_name` "Music", `start_url: "/"`, `display: "standalone"`, `background_color`/`theme_color: "#1f1f1e"`, `icons` referencing the three PNGs (192 any, 512 any, 512 maskable). Generate the icons self-hosted (a solid `--color-bg` square with a clay disc glyph — produce via a tiny Go/ImageMagick step or a committed static PNG; no external fetch). `sw.js`:
```js
// Minimal service worker: installability only, no offline caching (spec §15a).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
```
`index.html` head: `<link rel="manifest" href="/manifest.webmanifest">`, `<meta name="theme-color" content="#1f1f1e">`, `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<link rel="apple-touch-icon" href="/icon-192.png">`, `<meta name="apple-mobile-web-app-capable" content="yes">`.
`main.tsx` after render:
```ts
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
```

- [ ] **Step 2: Verify** the Go embed serves `ui/public` files. Vite copies `public/*` to `../backend/web/dist`; confirm `web/embed.go` serves them at root (check `web/embed.go`; if it strips unknown paths, ensure `/sw.js` + `/manifest.webmanifest` resolve). Add/adjust an `embed_test.go` assertion that `/manifest.webmanifest` and `/sw.js` are embedded after a build. (Build step: `make fe-build`.)

- [ ] **Step 3: Commit** — `git commit -m "feat(pwa): manifest, service worker, icons, installability"`

---

## Task 7: Resume-state persistence module

**Files:** Create `ui/src/resume.ts`, `ui/src/resume.test.ts`

**Interfaces (mirror `favorites.ts`, DI `Store = Pick<Storage,"getItem"|"setItem">`):**
- `type ResumeState = { songId: string; positionMs: number }`
- `saveResume(store, state: ResumeState): void` (key `"music.resume"`)
- `loadResume(store): ResumeState | null` (tolerates missing/corrupt JSON → null)
- `clearResume(store): void`

- [ ] **Step 1:** Tests: save→load round-trips; corrupt JSON → null; missing → null; clear removes.
- [ ] **Step 2–4:** fail → implement → pass (`npx vitest run src/resume.test.ts`).
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): resume-state localStorage module"`

---

## Task 8: Player store (audio singleton + queue/history/next/prev + qualified-play + MediaSession + resume)

**Files:** Create `ui/src/player.ts`, `ui/src/player.test.ts`; modify `ui/src/api.ts` (add `reportPlay`, `streamUrl` already exists).

This is the core refactor. Extract all pure logic (queue/history transitions, qualified-play decision) into testable functions; keep DOM/MediaSession side-effects in a thin singleton.

**Interfaces:**
- Pure, unit-tested:
  - `type PlayerState = { current: Song | null; queue: Song[]; history: Song[]; playing: boolean; positionMs: number; durationMs: number }`
  - `advance(state): PlayerState` — head of queue → current, current → history (for prev). Used by next + on-ended.
  - `back(state): PlayerState` — pop history → current, current → front of queue.
  - `qualifiesForPlay(positionMs, durationMs): boolean` — true when `positionMs >= 30_000 || (durationMs > 0 && positionMs >= durationMs/2)`. (≥30 s OR ≥50 % for short tracks.)
  - A `PlaySession` guard: once a track becomes `current`, a fresh session starts; `reportPlay` fires at most once per session (dedup). Model as `shouldReport(session: {reported:boolean}, qualifies:boolean): boolean` flipping `reported` true.
- Store/hook (side-effecting, exercised via Playwright not unit tests):
  - singleton `player` with `play(song, upNext?)`, `toggle()`, `next()`, `prev()`, `seek(ms)`, `setQueue`, subscribe.
  - `usePlayer(): PlayerState & { play; toggle; next; prev; seek }` — React hook subscribing to the singleton.
  - Owns one `<audio>` (created in module, appended once) so playback survives route changes.
  - `timeupdate` → update position; when `qualifiesForPlay` && session not reported → `api.reportPlay(current.id)` once.
  - On `current` change → set `navigator.mediaSession.metadata` (title/artist/album + artwork from `coverUrl(coverArtId,'card')`) and `setActionHandler` for `play/pause/nexttrack/previoustrack`; update `playbackState`.
  - Persist `{songId, positionMs}` via `saveResume` on `timeupdate` (throttled) + `pause`; expose `restore(songs)` to seed `current`+`positionMs` from `loadResume` WITHOUT autoplay (`playing=false`, set `audio.currentTime` on first user play).

- [ ] **Step 1:** `api.ts` add:
```ts
export function reportPlay(id: string): Promise<void> {
  return fetch(`/api/songs/${id}/play`, { method: "POST" }).then(() => {});
}
```
- [ ] **Step 2:** Write `player.test.ts` for `advance`, `back`, `qualifiesForPlay` (boundary: 29999→false, 30000→true; short 60 s track at 30 s →true via 50%; 20 s track at 12 s →true, at 8 s→false), and `shouldReport` once-only.
- [ ] **Step 3:** Run → fail. **Step 4:** implement pure fns + singleton → `npx vitest run src/player.test.ts` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): player store — queue/history, qualified-play dedup, MediaSession, resume"`

---

## Task 9: api.ts home/top-ten/search clients + types

**Files:** Modify `ui/src/api.ts`, `ui/src/cover.ts`; create `ui/src/api.test.ts`.

- [ ] **Step 1:** Tests (pure URL/shape): `coverUrl(id,"card")` → `/api/cover/{id}?size=card`; `coverUrl(id)` → `/api/cover/{id}`; verify `getHome`/`getTopTen`/`search` hit the right paths (mock `fetch`).
- [ ] **Step 2–4:** Add types `HomeFeed`, `HomeHero`, `GenreChapter`, `TopTenEntry`, `SearchResults`, `SearchHit`; add `getHome()`, `getTopTen()`, `search(q)`; extend `coverUrl(id, size?)`. Fail → implement → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): home/top-ten/search api clients + sized coverUrl"`

---

## Task 10: Immersive Home screen

**Files:** Create `ui/src/Home.tsx`, `ui/src/Hero.tsx`, `ui/src/Chapter.tsx`; modify `ui/src/index.css` (scrim/glass/tabular-nums utilities), `ui/src/App.tsx` (mount Home at `/`), `ui/src/router.ts` if needed.

**Interfaces:**
- `<Hero hero={HomeHero|null} onPlay accent>` — full-bleed `fanartUrl(id,"hero")` background + scrim + copy + Play/Download/Share; graceful when `hero==null` (quiet gradient using `--color-panel`).
- `<Chapter chapter={GenreChapter} onPlay>` — full-bleed `fanartUrl(backgroundFanartId,"hero")`, scrim, genre kicker/name/count, horizontal cover rail; accent from `chapter.accentColor`; graceful when no background.
- `<Home onPlay={(song, tail)=>...} authenticated>` — fetches `getHome`; renders Hero, Top-Ten chart (rank numbers Anthropic Sans tabular-nums, `plays` count, heart/menu per row), Recently-added tiles, one Chapter per genre, Playlists grid. Every section renders nothing (not an error) when its data is empty.

- [ ] **Step 1:** Add a Vitest render smoke test (jsdom) — `Home` with a mocked `getHome` returning empty feed renders without crashing and shows no AI text. Assert the DOM contains no "generate"/"prompt"/"AI" strings.
- [ ] **Step 2–4:** fail → implement components (inline-style + token convention; reuse `Icon`, `fanartUrl`, `coverUrl`, `onPlay(song, tail)`) → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): immersive home — hero, top-ten chart, recent, genre chapters, playlists"`

---

## Task 11: Unified immersive Detail template

**Files:** Create `ui/src/Detail.tsx`; modify `App.tsx` (route genre/artist/playlist → `Detail`), `router.ts` (add `artist{id}`), `api.ts` (`getArtist` if missing — backend `GET /api/artists/{id}` exists).

**Interfaces:**
- `<Detail kind={"genre"|"artist"|"playlist"} id onPlay authenticated>` — one template: full-bleed art (genre background fanart / playlist or artist cover) occupies top two-thirds; a glass song-list panel overlaps the lower third. Reuses existing per-kind fetchers. Preserves existing edit affordances (genre background editor, playlist editor) behind `authenticated`; keeps all Phase 3–5 features (flag before removing any).

- [ ] **Step 1:** Smoke test: `Detail kind="playlist"` with mocked fetch renders song rows and calls `onPlay` on row click.
- [ ] **Step 2–4:** fail → implement, folding the existing `GenreDetail`/`PlaylistDetail` behavior into the unified template (keep the old components until parity is verified in the running app; do not delete features). → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): unified immersive detail template (genre/artist/playlist)"`

---

## Task 12: Full-screen player + docked mini-player

**Files:** Create `ui/src/Player.tsx`; modify `App.tsx` (replace the inline `<audio controls>` bar with `usePlayer()`-driven mini-player + full-screen overlay), `index.css`.

**Interfaces:**
- `<MiniPlayer>` — docked bottom bar: cover, title/artist, play/pause/next/prev, seek, heart (localStorage), expand→full-screen. Driven entirely by `usePlayer()`.
- `<FullPlayer open onClose>` — full-screen: large cover/fanart, title/artist, transport, seek scrubber, heart, share, queue access.
- Both replace native `controls`. The heart uses `useFavorites()` on rows / mini / full.

- [ ] **Step 1:** Smoke test that `MiniPlayer` renders nothing when `current==null` and renders controls when a track is set (inject a fake player state).
- [ ] **Step 2–4:** fail → implement → pass. Remove the old inline `<audio controls>` (the player store owns audio now) — this is an intended replacement of the Phase 2 stopgap, note it in the commit body.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): full-screen player + docked mini-player over player store"`

---

## Task 13: Search screen + slim rail + mobile tab bar

**Files:** Create `ui/src/Search.tsx`, `ui/src/Rail.tsx`; modify `App.tsx`, `router.ts` (`search` route), `index.css` (rail + mobile tab bar responsive).

**Interfaces:**
- `<Rail route onNavigate authenticated>` — desktop slim icon-only left rail (home/search/genres/library, + upload when authenticated, greyed "Studio — soon"); on mobile, a bottom tab bar. No wordmark. Uses `Icon`.
- `<Search>` — debounced `search(q)`; grouped results: Top result card, then Songs / Artists / Genres / Playlists sections; each item navigates or plays.

- [ ] **Step 1:** Smoke test: `Search` with mocked `search` returning grouped data renders each group; empty query renders a quiet prompt.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): grouped search, slim icon rail, mobile tab bar"`

---

## Task 14: Wire qualified-play reporting end-to-end + resume restore in App

**Files:** Modify `ui/src/App.tsx` (or player init): call `player.restore(songs)` after songs load (no autoplay); ensure `timeupdate`→qualified→`reportPlay` path is live; ensure Top-Ten on Home reflects a new play after refresh.

- [ ] **Step 1:** (Covered by unit tests in Task 8 for the decision logic.) Add an integration note: this task is validated in the Playwright pass (Task 15), not a new unit test — the wiring is side-effectful.
- [ ] **Step 2:** Implement restore-on-load + confirm reporting fires once.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): resume restore on load + live qualified-play reporting"`

---

## Task 15: Live validation against real fanart (Playwright) + placement tuning loop

Not a code-only task — the spec (§8, and the brief) makes placement tuning against real photography a first-class step.

- [ ] **Step 1: Build + boot** with real config. `make fe-build`, then boot the binary with local temp paths and the BFL key sourced from the repo-root `.env`:
```bash
set -a; source /Users/jan/localgit/music/.env; set +a
export BACKEND_AUTH_MODE=dev BACKEND_SESSION_SECRET=dev-secret-loooong
export BACKEND_DB_PATH="$TMP/music.db" BACKEND_MEDIA_DIR="$TMP/media" BACKEND_LISTEN_ADDR=":8099"
(cd backend && go run ./cmd/music) &
```
(Note the real env var is `BACKEND_LISTEN_ADDR`, not `LISTEN_ADDR`.)
- [ ] **Step 2: Seed data** — upload a few sample MP3s (reuse `backend/internal/metadata/testdata/sample.mp3` + variants), create genres, then **generate real fanart** via the authenticated generate flow (BFL) for a couple of genres + a hero. Star a hero, set genre backgrounds.
- [ ] **Step 3: Playwright assertions** (MCP browser tools):
  1. Home hero + genre chapters render with **real** imagery; layout reads well (screenshot; iterate placement in `Hero`/`Chapter`/`Detail` until it looks right — the tuning loop).
  2. Full-screen + mini player play audio; `navigator.mediaSession.metadata` is set and `setActionHandler` registered for play/pause/next/prev (assert via `browser_evaluate` reading `navigator.mediaSession.metadata?.title` and a probe that handlers exist).
  3. Service worker registers (`navigator.serviceWorker.controller` or `getRegistrations().length>0`) and `/manifest.webmanifest` is served (200, correct `Content-Type`).
  4. A **qualified play** increments Top-Ten exactly once: play a track past 30 s (or seek near end), confirm `GET /api/top-ten` shows +1; refresh and confirm it did NOT double-count (client once-per-session + server throttle).
  5. Resume restores track + position after reload, WITHOUT surprise autoplay.
  6. Anonymous (boot a second run in `oidc` mode OR clear the dev identity) sees NO AI/prompt/generate text anywhere on home/detail/search.
- [ ] **Step 4:** Fix any layout/behavior issues found; re-run. Commit tuning changes: `git commit -am "fix(ui): tune immersive placement against real fanart; validation fixes"`.

---

## Task 16: Code review, then PR

- [ ] **Step 1:** `make test && make fe-test && make fe-build` all green.
- [ ] **Step 2:** Dispatch a generic code-review agent over the full branch diff. Focus areas (from the brief): the public `/play` exception vs. all other writes still gated; qualified-play de-dup + Top-Ten determinism; media/image sandboxing; the no-AI-in-UI invariant on new immersive surfaces; MediaSession/SW correctness + self-hosted-only; migration squash (no `0002_*.sql`, `plays` unchanged). Address findings.
- [ ] **Step 3:** Confirm the review agent did not leave the worktree on a different branch (`git -C <worktree> branch --show-current` == `feat/phase-6-immersive-ui-mediasession-pwa-topten`).
- [ ] **Step 4:** Open a PR with `gh` against `trick77/music` `master` (NOT any upstream). PR body documents the deliberate public `/play` write. **Do not merge without the user's explicit go-ahead.**
- [ ] **Step 5:** On go-ahead: merge, then remove the worktree.

---

## Self-Review (spec coverage)

- §9 play counting → Tasks 1,2,8,14,15. Qualified play defined (≥30 s OR ≥50 %), de-duped client (once/session) + server (throttle). Top-Ten deterministic (count DESC, lower(title), id). ✓
- §12 endpoints: `/play` (public), `/top-ten`, `/home`, `/search` → Tasks 2,3,4. ✓
- §15 immersive frontend: hero + chapters, unified detail, full-screen + mini player, mobile tab bar, rank tabular-nums, slim rail, no wordmark, heart everywhere → Tasks 10–13. ✓
- §15a MediaSession + PWA + resume + sized images → Tasks 5,6,7,8,14. ✓
- No-AI invariant on anonymous surfaces → Tasks 3,4,10,15 (assertions). ✓
- Security: only `/play` public, all other writes gated; media sandbox reused → Tasks 2,5,16. ✓
- Migration squash: no new columns; `plays` reused; no `0002` → Global Constraints + Task 16. ✓

**Deliberately NOT built** (Phase 7 / out of scope): OIDC/real auth sessions, offline caching, bulk edit, crossfade/gapless, download-as-zip.
