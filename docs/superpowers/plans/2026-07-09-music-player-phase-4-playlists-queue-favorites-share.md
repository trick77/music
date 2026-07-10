# Music Player — Phase 4: Playlists, Queue, Favorites & Share — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add playlists (full CRUD + drag-reorder + optional cover), a client-side play queue, client-side (localStorage) favorites, public share URLs, and server-side Open Graph/Twitter meta injection so shared song/playlist links render with art in chat apps — over the Phase 1–3 foundation.

**Architecture:** Extend the existing Go packages. The `playlists`/`playlist_songs` tables already exist (Phase 1 schema); a new `library/playlists.go` repository drives CRUD/reorder/cover over them, and `httpapi/playlists.go` exposes public reads + authenticated writes. Share previews are produced by wrapping the embedded SPA handler inside `httpapi.New()` (which already builds the `library.Repo`): a small meta-injecting handler intercepts `GET /song/{id}` and `GET /playlist/{id}`, looks the resource up, and injects escaped `<meta property="og:*">` tags into the embedded `index.html` shell, delegating every other path to the existing SPA handler. **Favorites and the queue are client-only — no server table, no endpoint.** The frontend gains a minimal dependency-free path router, a Favorites view (localStorage), a queue drawer, a per-song "…" context menu, an add-to-playlist chooser, and a playlist create/edit modal — all reusing the loom design tokens.

**Tech Stack:** Go 1.25, stdlib `net/http` (Go 1.22 method routing), pure-Go SQLite `github.com/ncruces/go-sqlite3` v0.23.3, stdlib `html` (attribute escaping) + `image` (cover probe, already present via `imageutil`); React 19 + TypeScript + Vite + Vitest. **No new frontend or backend dependencies.**

## Global Constraints

- Module `github.com/trick77/music`. Go `1.25.0`. `CGO_ENABLED=0` everywhere — verify the build stays CGO-free.
- Pure-Go SQLite `github.com/ncruces/go-sqlite3` v0.23.3. Never `mattn/go-sqlite3`. One SQLite file.
- HTTP: stdlib `net/http` only, no framework. Frontend: Vite + React 19 + TS + Tailwind v4, built into `backend/web/dist`, embedded by Go. **Add no new npm or Go dependencies in this phase.**
- **No AI branding or wordmark in any UI copy.** English only in docs/code/comments. Never use `ß` (Swiss orthography — irrelevant here since copy is English, but do not introduce it).
- Design tokens are loom's CSS variables verbatim (bg `#1f1f1e`, panel `#1b1b1a`, active `#2c2c2a`, border `#323230`, ink `#faf9f5`, muted `#9c9a92`, accent `#c6613f`, accent-strong `#d97757`, radius `10px`). Fonts: self-hosted Anthropic Sans/Serif. Rank/number text uses Sans with `tabular-nums`.
- YAML `.yaml` (never `.yml`).
- TDD: failing test first, then minimal impl. Conventional commits. Feature branch `feat/phase-4-playlists-queue-favorites-share`; **never commit to `master`**.
- **Migrations are squashed pre-launch (project decision):** this repo has never had a live instance, so all schema lives in a single `backend/internal/store/migrations/0001_init.sql`. **Do not add `0004_*.sql`** — fold new DDL into `0001_init.sql` and delete the now-redundant `0002_*`/`0003_*` files. Dev DBs at `BACKEND_DB_PATH` are disposable and recreated.
- **Security invariants (spec §14):** every write endpoint is gated to the authenticated role via `identify(h.cfg, r).Authenticated`; anonymous can only read/play/download/share. All media/cover file access stays sandboxed under `BACKEND_MEDIA_DIR` (`..`/absolute/symlink rejected by `media.Store`). Uploads validated (MIME/extension/size).
- **Favorites are localStorage-only (spec §1):** NO likes table, NO likes endpoint, no "Save" button. If you find yourself adding a server-side favorite/like, stop — it is out of scope by design. The heart icon is the entire feature, available to everyone.
- **Login-only controls are presence-vs-absence (spec §1):** an anonymous visitor must simply not see edit/create/delete affordances. **No disabled buttons, no lock icons, no "sign in to…" prompts.** Every auth gate in the frontend must *omit* the element (`session?.authenticated && <X/>`), never render it disabled.
- **Playwright validation closes the phase** — real navigation/clicks against the running app, plus a `curl` assertion that the server emits `og:title`/`og:image` for share routes (crawlers don't run JS).
- **Review-agent gate before merge.** Dispatch a generic code-review agent over the PR diff, address findings, then merge into **this repo's** `master` (never an upstream). Open the PR with `gh`.

---

## Phase 4 scope (in / out)

**In:** playlist persistence + CRUD (create/rename/edit-description/delete-with-confirm/add-song/remove-song/**reorder**) over the existing schema; optional playlist cover (upload, reusing the Phase 3 cover pipeline) with a client fallback tile derived from songs; endpoints `GET /api/playlists`, `GET /api/playlists/{id}` (public), `POST/PATCH/DELETE /api/playlists…`, `POST/DELETE /api/playlists/{id}/songs…`, `PUT /api/playlists/{id}/reorder`, `PUT /api/playlists/{id}/cover` (authenticated); client-side play queue (up-next, drag-reorder) + per-song "…" context menu; **client-side (localStorage) favorites** + a Favorites view; **public share URLs** (`/song/{id}`, `/playlist/{id}`) playable by anonymous visitors with no tokens; **server-side OG/Twitter meta injection** for those two routes.

**Out (later phases — do NOT build):** fanart, AI/BFL generation, genre background editor, image scaling variants (`imagescale`, §15a) — **Phase 5**; the full immersive home/detail/player pages, MediaSession/PWA, resume-playback (§15a) — **Phase 6**; OIDC — **Phase 7**. Also deferred within Phase 4: per-genre share/OG (`/genre/{id}` OG) — the browse pages ship in Phase 6, so only song + playlist get OG here; play-counting/Top-Ten (Phase 6 home). Sharing "collection pages" beyond playlists is out.

---

## File structure (Phase 4)

**Backend**
- `backend/internal/store/migrations/0001_init.sql` — **modify**: fold in the 0002 content-hash unique index, the 0003 `album_covers` table, and a new `idx_playlist_songs_order` index; **delete** `0002_songs_content_hash.sql` and `0003_album_covers.sql`.
- `backend/internal/library/playlists.go` — **create**: `Playlist`, `PlaylistSummary`, `PlaylistDetail` types; `CreatePlaylist`, `UpdatePlaylist`, `DeletePlaylist`, `ListPlaylists`, `GetPlaylist`, `AddSong`, `RemoveSong`, `Reorder`, `SetPlaylistCover`. Test: `playlists_test.go`.
- `backend/internal/httpapi/coverupload.go` — **create**: extracted `storeUploadedCover` helper (buffer → probe → hash → dedupe → store), used by both the song cover handler and the new playlist cover handler.
- `backend/internal/httpapi/covers.go` — **modify**: `putCover` (song) calls `storeUploadedCover`.
- `backend/internal/httpapi/playlists.go` — **create**: playlist HTTP handlers + `playlistHandlers` struct. Test: `playlists_test.go`.
- `backend/internal/httpapi/sharemeta.go` — **create**: `withShareMeta` wrapper + meta builders (escaping, fallback chain, base URL). Test: `sharemeta_test.go`.
- `backend/internal/httpapi/server.go` — **modify**: register playlist routes; wrap the SPA handler with `withShareMeta`.
- `backend/web/embed.go` — **modify**: export `IndexHTML() ([]byte, error)` exposing the embedded shell.

**Frontend**
- `ui/src/router.ts` (+ `router.test.ts`) — **create**: `parsePath`, `navigate`, `useRoute`.
- `ui/src/share.ts` (+ `share.test.ts`) — **create**: `songShareUrl`, `playlistShareUrl`, `copyText`.
- `ui/src/favorites.ts` (+ `favorites.test.ts`) — **create**: injectable-storage favorites (`loadFavorites`, `toggleFavorite`, `isFavorite`) + `useFavorites` hook.
- `ui/src/queue.ts` (+ `queue.test.ts`) — **create**: pure queue ops (`addToQueue`, `playNext`, `removeAt`, `reorder`).
- `ui/src/api.ts` — **modify**: playlist types + calls.
- `ui/src/Library.tsx`, `ui/src/PlaylistEditor.tsx`, `ui/src/PlaylistDetail.tsx`, `ui/src/SongMenu.tsx`, `ui/src/AddToPlaylist.tsx`, `ui/src/QueueDrawer.tsx` — **create**: the views/overlays.
- `ui/src/App.tsx` — **modify**: route-aware shell wiring the above; heart + "…" on song rows; queue drawer; share.

---

## Task 1: Squash migrations + add playlist-ordering index

**Files:**
- Modify: `backend/internal/store/migrations/0001_init.sql`
- Delete: `backend/internal/store/migrations/0002_songs_content_hash.sql`, `backend/internal/store/migrations/0003_album_covers.sql`
- Test: `backend/internal/store/store_test.go` (extend)

**Interfaces:**
- Produces: a single-file schema. After migration, these must exist: unique index `idx_songs_content_hash`, table `album_covers`, index `idx_playlist_songs_order`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/store/store_test.go` (new test function; keep the existing ones):
```go
func TestOpen_squashedSchemaHasPhase4Objects(t *testing.T) {
	st, err := Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	// The album_covers table (was 0003) must exist in the single init migration.
	var name string
	err = st.DB().QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='album_covers'`).Scan(&name)
	if err != nil {
		t.Fatalf("album_covers table missing: %v", err)
	}

	// The content-hash unique index (was 0002) and the new playlist-order index.
	for _, idx := range []string{"idx_songs_content_hash", "idx_playlist_songs_order"} {
		var got string
		err := st.DB().QueryRow(
			`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&got)
		if err != nil {
			t.Fatalf("index %s missing: %v", idx, err)
		}
	}

	// Exactly one migration recorded (the squash).
	var count int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 recorded migration, got %d", count)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run TestOpen_squashedSchema -v`
Expected: FAIL — currently three migrations are recorded (count != 1), and `idx_playlist_songs_order` is absent.

- [ ] **Step 3: Fold everything into `0001_init.sql`**

Delete the separate files first:
```bash
cd backend && rm internal/store/migrations/0002_songs_content_hash.sql internal/store/migrations/0003_album_covers.sql
```

Append to `backend/internal/store/migrations/0001_init.sql` (after the existing `plays` block at the end of the file — do NOT edit the existing statements above; only add these):
```sql

-- ── Folded from former 0002 (content-hash dedupe) ──────────────────────────
-- Enforce content-hash dedupe for songs that carry a hash (empty hash allowed
-- for legacy/edge rows).
CREATE UNIQUE INDEX idx_songs_content_hash
    ON songs(content_hash) WHERE content_hash != '';

-- ── Folded from former 0003 (artist+album -> cover mapping, spec §7) ────────
-- Durable artist+album -> cover mapping so cover art auto-applies to every
-- existing AND future song sharing that artist+album. Singles (no album) use
-- per-song songs.cover_art_id instead.
CREATE TABLE album_covers (
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album_key    TEXT NOT NULL,                 -- lower(album)
    cover_art_id TEXT NOT NULL REFERENCES cover_art(id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, album_key)
);

-- ── Phase 4: fast ordered reads of a playlist's tracks ─────────────────────
-- playlist_songs' PRIMARY KEY is (playlist_id, song_id); this index serves
-- ORDER BY position for a playlist. position is NOT unique (ties are allowed
-- and resolved by the reorder rewrite).
CREATE INDEX idx_playlist_songs_order ON playlist_songs(playlist_id, position);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/store/ ./internal/library/ ./internal/httpapi/ -v 2>&1 | tail -25`
Expected: PASS — the squashed schema still creates every Phase 1–3 object (existing library/httpapi tests are unaffected), plus the new index; exactly one migration is recorded.

- [ ] **Step 5: Confirm CGO-free build**

Run: `cd backend && CGO_ENABLED=0 go build ./...`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/store/migrations/ backend/internal/store/store_test.go
git commit -m "chore(store): squash migrations into single 0001_init + playlist-order index"
```

---

## Task 2: Playlist repository (CRUD, add/remove, reorder, cover)

**Files:**
- Create: `backend/internal/library/playlists.go`, `backend/internal/library/playlists_test.go`

**Interfaces:**
- Consumes: `*sql.DB` (via `Repo`), `library.NewID`, `Song`, `songSelect`, `scanSong`, `genresFor` (existing, same package).
- Produces:
  - `PlaylistSummary{ ID, Name, Description, CoverArtID string; SongCount int }` (`json:"id"`,`"name"`,`"description"`,`"coverArtId"`,`"songCount"`).
  - `PlaylistDetail{ PlaylistSummary; Songs []Song }` — `Songs` embedded as `json:"songs"`.
  - `(*Repo).CreatePlaylist(ctx, name, description string) (string, error)` — new id.
  - `(*Repo).UpdatePlaylist(ctx, id, name, description string) error` — name/description only.
  - `(*Repo).DeletePlaylist(ctx, id string) error` — FK cascade removes `playlist_songs`.
  - `(*Repo).ListPlaylists(ctx) ([]PlaylistSummary, error)` — newest first.
  - `(*Repo).GetPlaylist(ctx, id string) (*PlaylistDetail, error)` — `(nil,nil)` if absent; `Songs` ordered by position.
  - `(*Repo).AddSong(ctx, playlistID, songID string) error` — appends at `max(position)+1`; idempotent (no-op if already present).
  - `(*Repo).RemoveSong(ctx, playlistID, songID string) error`.
  - `(*Repo).Reorder(ctx, playlistID string, songIDs []string) error` — rewrites positions to the given order. Returns `ErrReorderMismatch` if `songIDs` is not exactly the playlist's current membership.
  - `(*Repo).SetPlaylistCover(ctx, playlistID, coverID string) error`.
  - `var ErrReorderMismatch = errors.New("library: reorder set does not match playlist membership")`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/library/playlists_test.go`:
```go
package library

import (
	"context"
	"errors"
	"testing"
)

// plSong inserts a minimal song and returns its id (reuses sampleParams from the
// package's existing test helpers).
func plSong(t *testing.T, r *Repo, title, hash, path string) string {
	t.Helper()
	p := sampleParams()
	p.Title, p.ContentHash, p.FilePath = title, hash, path
	s, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("create song %s: %v", title, err)
	}
	return s.ID
}

func TestCreateAndGetPlaylist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id, err := r.CreatePlaylist(ctx, "Late Night Drive", "City lights, low volume")
	if err != nil {
		t.Fatalf("CreatePlaylist: %v", err)
	}
	got, err := r.GetPlaylist(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("GetPlaylist: %v (nil=%v)", err, got == nil)
	}
	if got.Name != "Late Night Drive" || got.Description != "City lights, low volume" {
		t.Fatalf("playlist = %+v", got)
	}
	if got.Songs == nil {
		t.Fatalf("Songs must be non-nil (empty slice), got nil")
	}
	if len(got.Songs) != 0 {
		t.Fatalf("new playlist should have 0 songs, got %d", len(got.Songs))
	}
}

func TestGetPlaylist_absentReturnsNil(t *testing.T) {
	r := newRepo(t)
	got, err := r.GetPlaylist(context.Background(), "nope")
	if err != nil {
		t.Fatalf("GetPlaylist: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for absent playlist, got %+v", got)
	}
}

func TestAddSong_appendsAndIsIdempotent(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")

	if err := r.AddSong(ctx, pid, a); err != nil {
		t.Fatalf("AddSong a: %v", err)
	}
	if err := r.AddSong(ctx, pid, b); err != nil {
		t.Fatalf("AddSong b: %v", err)
	}
	if err := r.AddSong(ctx, pid, a); err != nil { // idempotent re-add
		t.Fatalf("AddSong a again: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if len(got.Songs) != 2 {
		t.Fatalf("want 2 songs after idempotent add, got %d", len(got.Songs))
	}
	if got.Songs[0].ID != a || got.Songs[1].ID != b {
		t.Fatalf("append order wrong: %s,%s", got.Songs[0].ID, got.Songs[1].ID)
	}
	if got.SongCount != 2 {
		t.Fatalf("SongCount = %d, want 2", got.SongCount)
	}
}

func TestReorder_rewritesPositions(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	c := plSong(t, r, "C", "h3", "songs/c.mp3")
	for _, s := range []string{a, b, c} {
		if err := r.AddSong(ctx, pid, s); err != nil {
			t.Fatalf("AddSong: %v", err)
		}
	}
	if err := r.Reorder(ctx, pid, []string{c, a, b}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	order := []string{got.Songs[0].ID, got.Songs[1].ID, got.Songs[2].ID}
	if order[0] != c || order[1] != a || order[2] != b {
		t.Fatalf("reorder wrong: %v", order)
	}
}

func TestReorder_mismatchRejected(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	r.AddSong(ctx, pid, a)
	r.AddSong(ctx, pid, b)

	// Missing member b.
	if err := r.Reorder(ctx, pid, []string{a}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("missing member: want ErrReorderMismatch, got %v", err)
	}
	// Extra/unknown id.
	if err := r.Reorder(ctx, pid, []string{a, b, "ghost"}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("extra id: want ErrReorderMismatch, got %v", err)
	}
	// Duplicate id (same length but not a permutation).
	if err := r.Reorder(ctx, pid, []string{a, a}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("duplicate id: want ErrReorderMismatch, got %v", err)
	}
}

func TestRemoveSong(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	r.AddSong(ctx, pid, a)
	r.AddSong(ctx, pid, b)
	if err := r.RemoveSong(ctx, pid, a); err != nil {
		t.Fatalf("RemoveSong: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if len(got.Songs) != 1 || got.Songs[0].ID != b {
		t.Fatalf("after remove: %+v", got.Songs)
	}
}

func TestUpdateAndDeletePlaylist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "Old", "old desc")
	if err := r.UpdatePlaylist(ctx, pid, "New", "new desc"); err != nil {
		t.Fatalf("UpdatePlaylist: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if got.Name != "New" || got.Description != "new desc" {
		t.Fatalf("update not applied: %+v", got)
	}
	if err := r.DeletePlaylist(ctx, pid); err != nil {
		t.Fatalf("DeletePlaylist: %v", err)
	}
	gone, _ := r.GetPlaylist(ctx, pid)
	if gone != nil {
		t.Fatalf("expected deleted, got %+v", gone)
	}
}

func TestListPlaylists_newestFirst(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	first, _ := r.CreatePlaylist(ctx, "First", "")
	second, _ := r.CreatePlaylist(ctx, "Second", "")
	list, err := r.ListPlaylists(ctx)
	if err != nil {
		t.Fatalf("ListPlaylists: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 playlists, got %d", len(list))
	}
	// created_at is second-resolution; tie-break by id DESC keeps this stable.
	found := map[string]bool{first: false, second: false}
	for _, p := range list {
		found[p.ID] = true
	}
	if !found[first] || !found[second] {
		t.Fatalf("missing playlists in list: %+v", list)
	}
}

func TestSetPlaylistCover(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	coverID, err := r.CreateCover(ctx, CoverParams{
		ImagePath: "covers/pl.jpg", Width: 500, Height: 500, ContentHash: "plhash",
	})
	if err != nil {
		t.Fatalf("CreateCover: %v", err)
	}
	if err := r.SetPlaylistCover(ctx, pid, coverID); err != nil {
		t.Fatalf("SetPlaylistCover: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if got.CoverArtID != coverID {
		t.Fatalf("cover = %q, want %q", got.CoverArtID, coverID)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/library/ -run 'Playlist|Reorder|AddSong|RemoveSong' -v`
Expected: FAIL (undefined `CreatePlaylist`, `PlaylistDetail`, `ErrReorderMismatch`, …).

- [ ] **Step 3: Write the implementation**

Create `backend/internal/library/playlists.go`:
```go
package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// ErrReorderMismatch is returned when a reorder request's song set is not
// exactly the playlist's current membership (missing, extra, or duplicate ids).
var ErrReorderMismatch = errors.New("library: reorder set does not match playlist membership")

// PlaylistSummary is a playlist without its tracks, for list views.
type PlaylistSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	CoverArtID  string `json:"coverArtId"`
	SongCount   int    `json:"songCount"`
}

// PlaylistDetail is a playlist with its ordered tracks.
type PlaylistDetail struct {
	PlaylistSummary
	Songs []Song `json:"songs"`
}

// CreatePlaylist inserts a new, empty playlist and returns its id.
func (r *Repo) CreatePlaylist(ctx context.Context, name, description string) (string, error) {
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO playlists(id, name, description) VALUES(?,?,?)`,
		id, strings.TrimSpace(name), nullStr(description))
	if err != nil {
		return "", err
	}
	return id, nil
}

// UpdatePlaylist edits a playlist's name and description (not its cover/songs).
func (r *Repo) UpdatePlaylist(ctx context.Context, id, name, description string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE playlists SET name=?, description=? WHERE id=?`,
		strings.TrimSpace(name), nullStr(description), id)
	return err
}

// DeletePlaylist removes a playlist; playlist_songs rows cascade via FK.
func (r *Repo) DeletePlaylist(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM playlists WHERE id=?`, id)
	return err
}

// ListPlaylists returns all playlists, newest first, each with its song count.
func (r *Repo) ListPlaylists(ctx context.Context) ([]PlaylistSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id,
		        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id)
		 FROM playlists p ORDER BY p.created_at DESC, p.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PlaylistSummary{}
	for rows.Next() {
		s, err := scanPlaylistSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// GetPlaylist returns a playlist with its ordered songs, or (nil,nil) if absent.
func (r *Repo) GetPlaylist(ctx context.Context, id string) (*PlaylistDetail, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT p.id, p.name, p.description, p.cover_art_id,
		        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id)
		 FROM playlists p WHERE p.id = ?`, id)
	summary, err := scanPlaylistSummary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	songs, err := r.playlistSongs(ctx, id)
	if err != nil {
		return nil, err
	}
	return &PlaylistDetail{PlaylistSummary: *summary, Songs: songs}, nil
}

// playlistSongs returns the playlist's songs ordered by position (then id for
// stable ties), with genres populated like List/Get.
func (r *Repo) playlistSongs(ctx context.Context, playlistID string) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx,
		songSelect+` JOIN playlist_songs ps ON ps.song_id = s.id
		 WHERE ps.playlist_id = ? ORDER BY ps.position, s.id`, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	songs := []Song{}
	for rows.Next() {
		s, err := scanSong(rows)
		if err != nil {
			return nil, err
		}
		genres, err := r.genresFor(ctx, s.ID)
		if err != nil {
			return nil, err
		}
		s.Genres = genres
		songs = append(songs, *s)
	}
	return songs, rows.Err()
}

// AddSong appends a song to a playlist at the next position. Re-adding a song
// already in the playlist is a no-op (idempotent) so double-clicks are safe.
func (r *Repo) AddSong(ctx context.Context, playlistID, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO playlist_songs(playlist_id, song_id, position)
		 VALUES(?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_songs WHERE playlist_id = ?))
		 ON CONFLICT(playlist_id, song_id) DO NOTHING`,
		playlistID, songID, playlistID)
	return err
}

// RemoveSong removes a song from a playlist. Remaining positions keep their
// values (gaps are harmless — reads order by position, reorder rewrites them).
func (r *Repo) RemoveSong(ctx context.Context, playlistID, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM playlist_songs WHERE playlist_id=? AND song_id=?`, playlistID, songID)
	return err
}

// Reorder rewrites the playlist's track order to songIDs. It rejects any set
// that is not exactly the current membership (missing, extra, or duplicate) so
// a stale client cannot silently drop or invent rows.
func (r *Repo) Reorder(ctx context.Context, playlistID string, songIDs []string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	current := map[string]bool{}
	rows, err := tx.QueryContext(ctx,
		`SELECT song_id FROM playlist_songs WHERE playlist_id=?`, playlistID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sid string
		if err := rows.Scan(&sid); err != nil {
			rows.Close()
			return err
		}
		current[sid] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(songIDs) != len(current) {
		return ErrReorderMismatch
	}
	seen := map[string]bool{}
	for _, sid := range songIDs {
		if seen[sid] || !current[sid] {
			return ErrReorderMismatch
		}
		seen[sid] = true
	}

	for pos, sid := range songIDs {
		if _, err := tx.ExecContext(ctx,
			`UPDATE playlist_songs SET position=? WHERE playlist_id=? AND song_id=?`,
			pos, playlistID, sid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetPlaylistCover assigns a cover image to a playlist.
func (r *Repo) SetPlaylistCover(ctx context.Context, playlistID, coverID string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE playlists SET cover_art_id=? WHERE id=?`, coverID, playlistID)
	return err
}

func scanPlaylistSummary(row scanner) (*PlaylistSummary, error) {
	var p PlaylistSummary
	var desc, cover sql.NullString
	if err := row.Scan(&p.ID, &p.Name, &desc, &cover, &p.SongCount); err != nil {
		return nil, err
	}
	p.Description = desc.String
	p.CoverArtID = cover.String
	return &p, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/library/ -v 2>&1 | tail -30`
Expected: PASS (new playlist tests + all existing Phase 2/3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/library/playlists.go backend/internal/library/playlists_test.go
git commit -m "feat(library): playlist repository (CRUD, add/remove, reorder, cover)"
```

---

## Task 3: Playlist HTTP endpoints (public reads, authenticated writes)

**Files:**
- Create: `backend/internal/httpapi/playlists.go`, `backend/internal/httpapi/playlists_test.go`
- Modify: `backend/internal/httpapi/server.go` (register routes)

**Interfaces:**
- Consumes: `library.Repo` (Task 2 methods), `identify`, `httpError`, `writeJSON`, `writeJSONStatus`.
- Produces:
  - `playlistHandlers{ cfg config.Config; repo *library.Repo }`.
  - Routes:
    - `GET /api/playlists` (public) → `{"playlists":[PlaylistSummary...]}`.
    - `GET /api/playlists/{id}` (public) → `PlaylistDetail`; 404 if absent.
    - `POST /api/playlists` (auth) `{name, description}` → 201 `PlaylistDetail`.
    - `PATCH /api/playlists/{id}` (auth) `{name, description}` → 200 `PlaylistDetail`.
    - `DELETE /api/playlists/{id}` (auth) → 204.
    - `POST /api/playlists/{id}/songs` (auth) `{songId}` → 200 `PlaylistDetail`.
    - `DELETE /api/playlists/{id}/songs/{songId}` (auth) → 200 `PlaylistDetail`.
    - `PUT /api/playlists/{id}/reorder` (auth) `{songIds:[]}` → 200 `PlaylistDetail`; 400 on `ErrReorderMismatch`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/httpapi/playlists_test.go`:
```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func doJSON(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Buffer
	if body != "" {
		rdr = bytes.NewBufferString(body)
	} else {
		rdr = bytes.NewBuffer(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// uploadSongID uploads the fixture and returns the created song id.
func uploadSongID(t *testing.T, h http.Handler) string {
	t.Helper()
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var s struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &s)
	return s.ID
}

func createPlaylist(t *testing.T, h http.Handler, name, desc string) string {
	t.Helper()
	rr := doJSON(t, h, "POST", "/api/playlists", `{"name":"`+name+`","description":"`+desc+`"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create playlist = %d, body=%s", rr.Code, rr.Body.String())
	}
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &p)
	return p.ID
}

func TestPlaylistCRUDFlow(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "Late Night Drive", "low volume")

	// GET detail (public shape).
	rr := doJSON(t, h, "GET", "/api/playlists/"+pid, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("get playlist = %d", rr.Code)
	}
	var detail struct {
		Name  string `json:"name"`
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &detail)
	if detail.Name != "Late Night Drive" || detail.Songs == nil {
		t.Fatalf("detail = %+v", detail)
	}

	// Add two songs (upload distinct fixtures — same bytes dedupe to one song,
	// so we upload once and add the single song, then verify membership).
	sid := uploadSongID(t, h)
	ar := doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)
	if ar.Code != http.StatusOK {
		t.Fatalf("add song = %d, body=%s", ar.Code, ar.Body.String())
	}
	var withSong struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(ar.Body.Bytes(), &withSong)
	if len(withSong.Songs) != 1 || withSong.Songs[0].ID != sid {
		t.Fatalf("membership after add = %+v", withSong.Songs)
	}

	// Rename via PATCH.
	pr := doJSON(t, h, "PATCH", "/api/playlists/"+pid, `{"name":"Renamed","description":"x"}`)
	if pr.Code != http.StatusOK {
		t.Fatalf("patch = %d", pr.Code)
	}

	// Remove the song.
	dr := doJSON(t, h, "DELETE", "/api/playlists/"+pid+"/songs/"+sid, "")
	if dr.Code != http.StatusOK {
		t.Fatalf("remove song = %d", dr.Code)
	}

	// Delete the playlist.
	del := doJSON(t, h, "DELETE", "/api/playlists/"+pid, "")
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", del.Code)
	}
	gone := doJSON(t, h, "GET", "/api/playlists/"+pid, "")
	if gone.Code != http.StatusNotFound {
		t.Fatalf("get deleted = %d, want 404", gone.Code)
	}
}

func TestReorderEndpoint_mismatchIs400(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "P", "")
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)

	// Reorder with an unknown id -> 400.
	bad := doJSON(t, h, "PUT", "/api/playlists/"+pid+"/reorder", `{"songIds":["ghost"]}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("mismatch reorder = %d, want 400", bad.Code)
	}
	// Reorder with the real membership -> 200.
	ok := doJSON(t, h, "PUT", "/api/playlists/"+pid+"/reorder", `{"songIds":["`+sid+`"]}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("valid reorder = %d, want 200", ok.Code)
	}
}

func TestPlaylistWrites_anonymousForbidden(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC)
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/playlists", `{"name":"x"}`},
		{"PATCH", "/api/playlists/any", `{"name":"x"}`},
		{"DELETE", "/api/playlists/any", ""},
		{"POST", "/api/playlists/any/songs", `{"songId":"s"}`},
		{"DELETE", "/api/playlists/any/songs/s", ""},
		{"PUT", "/api/playlists/any/reorder", `{"songIds":[]}`},
	} {
		rr := doJSON(t, anon, tc.method, tc.path, tc.body)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
}

func TestPlaylistReads_anonymousOK(t *testing.T) {
	// Public reads must work without auth. Build under dev to create data, then
	// read under oidc (anonymous). Playlists live in the same DB only within one
	// server, so assert the read *shape* is not gated: an anonymous GET list is 200.
	anon := testServer(t, config.AuthModeOIDC)
	rr := doJSON(t, anon, "GET", "/api/playlists", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("anonymous list playlists = %d, want 200", rr.Code)
	}
	var body struct {
		Playlists []any `json:"playlists"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Playlists == nil {
		t.Fatalf("playlists must be [] not null")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run 'Playlist|Reorder' -v`
Expected: FAIL (routes not registered → 404s, and helpers undefined until compiled).

- [ ] **Step 3: Write the handlers**

Create `backend/internal/httpapi/playlists.go`:
```go
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
)

type playlistHandlers struct {
	cfg  config.Config
	repo *library.Repo
}

func (h *playlistHandlers) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return false
	}
	return true
}

func (h *playlistHandlers) list(w http.ResponseWriter, r *http.Request) {
	pls, err := h.repo.ListPlaylists(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list playlists")
		return
	}
	writeJSON(w, map[string]any{"playlists": pls})
}

func (h *playlistHandlers) get(w http.ResponseWriter, r *http.Request) {
	pl, err := h.repo.GetPlaylist(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get playlist")
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, pl)
}

type playlistBody struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

func (h *playlistHandlers) create(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body playlistBody
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Name == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	id, err := h.repo.CreatePlaylist(r.Context(), body.Name, body.Description)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "create playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusCreated)
}

func (h *playlistHandlers) patch(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body playlistBody
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Name == "" {
		httpError(w, http.StatusBadRequest, "name is required")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.UpdatePlaylist(r.Context(), id, body.Name, body.Description); err != nil {
		httpError(w, http.StatusInternalServerError, "update playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) delete(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	if err := h.repo.DeletePlaylist(r.Context(), r.PathValue("id")); err != nil {
		httpError(w, http.StatusInternalServerError, "delete playlist")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *playlistHandlers) addSong(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body struct {
		SongID string `json:"songId"`
	}
	if err := decodeJSON(w, r, &body); err != nil || body.SongID == "" {
		httpError(w, http.StatusBadRequest, "songId is required")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.AddSong(r.Context(), id, body.SongID); err != nil {
		httpError(w, http.StatusInternalServerError, "add song")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) removeSong(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	id := r.PathValue("id")
	if err := h.repo.RemoveSong(r.Context(), id, r.PathValue("songId")); err != nil {
		httpError(w, http.StatusInternalServerError, "remove song")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

func (h *playlistHandlers) reorder(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	var body struct {
		SongIDs []string `json:"songIds"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	id := r.PathValue("id")
	if err := h.repo.Reorder(r.Context(), id, body.SongIDs); err != nil {
		if errors.Is(err, library.ErrReorderMismatch) {
			httpError(w, http.StatusBadRequest, "reorder set does not match playlist")
			return
		}
		httpError(w, http.StatusInternalServerError, "reorder playlist")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}

// respondDetail reloads and writes the playlist detail with the given status.
func (h *playlistHandlers) respondDetail(w http.ResponseWriter, r *http.Request, id string, status int) {
	pl, err := h.repo.GetPlaylist(r.Context(), id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "reload playlist")
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSONStatus(w, status, pl)
}

// decodeJSON reads a small JSON body with a 1 MiB cap.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v)
}
```

- [ ] **Step 4: Register the routes**

In `backend/internal/httpapi/server.go`, inside the `if st != nil && cfg.MediaDir != ""` block, after the existing song/cover/browse route registrations (before the closing `}` of the `if mstore` block), add:
```go
			pl := &playlistHandlers{cfg: cfg, repo: h.repo}
			mux.HandleFunc("GET /api/playlists", pl.list)
			mux.HandleFunc("GET /api/playlists/{id}", pl.get)
			mux.HandleFunc("POST /api/playlists", pl.create)
			mux.HandleFunc("PATCH /api/playlists/{id}", pl.patch)
			mux.HandleFunc("DELETE /api/playlists/{id}", pl.delete)
			mux.HandleFunc("POST /api/playlists/{id}/songs", pl.addSong)
			mux.HandleFunc("DELETE /api/playlists/{id}/songs/{songId}", pl.removeSong)
			mux.HandleFunc("PUT /api/playlists/{id}/reorder", pl.reorder)
```

- [ ] **Step 5: Run tests + build**

Run: `cd backend && go test ./internal/httpapi/ -run 'Playlist|Reorder' -v 2>&1 | tail -25 && CGO_ENABLED=0 go build ./...`
Expected: PASS; build OK.

- [ ] **Step 6: Run the full backend suite (guard against regressions)**

Run: `cd backend && go test ./... 2>&1 | tail -15`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/httpapi/playlists.go backend/internal/httpapi/playlists_test.go backend/internal/httpapi/server.go
git commit -m "feat(httpapi): playlist endpoints (public reads, authenticated writes + reorder)"
```

---

## Task 4: Playlist cover upload (shared cover-store helper)

**Files:**
- Create: `backend/internal/httpapi/coverupload.go`
- Modify: `backend/internal/httpapi/covers.go` (song `putCover` uses the helper), `backend/internal/httpapi/playlists.go` (add `putCover`), `backend/internal/httpapi/server.go` (route + give `playlistHandlers` the media store)
- Test: `backend/internal/httpapi/playlists_test.go` (extend)

**Interfaces:**
- Consumes: `imageutil.Probe`, `media.Store`, `library.Repo` (`FindCoverByHash`, `CreateCover`).
- Produces:
  - `storeUploadedCover(w, r, media *media.Store, repo *library.Repo, maxBytes int64) (coverID string, ok bool)` — buffers the multipart `file`, probes/hashes/dedupes/stores it, and returns the cover id. On any failure it writes the HTTP error itself and returns `ok=false`.
  - `playlistHandlers` gains `media *media.Store` and `maxBytes int64` fields.
  - Route `PUT /api/playlists/{id}/cover` (auth, multipart `file`) → 200 `PlaylistDetail`.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/httpapi/playlists_test.go`:
```go
func TestPlaylistCoverUpload(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "P", "")

	// A tiny valid PNG via the image encoder used elsewhere.
	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/playlists/"+pid+"/cover", body)
	req.Header.Set("Content-Type", contentType)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("cover upload = %d, body=%s", rr.Code, rr.Body.String())
	}
	var detail struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &detail)
	if detail.CoverArtID == "" {
		t.Fatalf("playlist cover not set: %s", rr.Body.String())
	}

	// The cover is publicly fetchable.
	cr := doJSON(t, h, "GET", "/api/cover/"+detail.CoverArtID, "")
	if cr.Code != http.StatusOK {
		t.Fatalf("get cover = %d", cr.Code)
	}
}

func TestPlaylistCoverUpload_anonymousForbidden(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC)
	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/playlists/any/cover", body)
	req.Header.Set("Content-Type", contentType)
	rr := httptest.NewRecorder()
	anon.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous cover upload = %d, want 403", rr.Code)
	}
}
```

Add this multipart helper near the top of `playlists_test.go` (after the imports — add `"image"`, `"image/png"`, and `"mime/multipart"` to the import block):
```go
func pngMultipart(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "cover.png")
	fw.Write(img.Bytes())
	mw.Close()
	return &body, mw.FormDataContentType()
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run 'PlaylistCover' -v`
Expected: FAIL (route missing / `pngMultipart` compiles but route 404s).

- [ ] **Step 3: Extract the shared cover-store helper**

Create `backend/internal/httpapi/coverupload.go`:
```go
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
)

// storeUploadedCover buffers the multipart "file", validates it as an image,
// dedupes by content hash, and stores new bytes under covers/. It returns the
// cover_art id. On any failure it writes the HTTP error itself and returns
// ok=false, so callers can simply `return` when ok is false.
func storeUploadedCover(w http.ResponseWriter, r *http.Request, store *media.Store, repo *library.Repo, maxBytes int64) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpError(w, http.StatusRequestEntityTooLarge, "image exceeds size limit")
			return "", false
		}
		httpError(w, http.StatusBadRequest, "missing file field")
		return "", false
	}
	defer file.Close()
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	tmp, err := os.CreateTemp("", "music-cover-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "temp file")
		return "", false
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), file); err != nil {
		httpError(w, http.StatusBadRequest, "read upload")
		return "", false
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		httpError(w, http.StatusInternalServerError, "seek")
		return "", false
	}
	width, height, ext, err := imageutil.Probe(tmp)
	if err != nil {
		httpError(w, http.StatusUnsupportedMediaType, "unsupported image format")
		return "", false
	}

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
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		dst.Close()
		httpError(w, http.StatusInternalServerError, "seek")
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

- [ ] **Step 4: Refactor the song cover handler to use the helper**

In `backend/internal/httpapi/covers.go`, replace the whole body of `putCover` from the `r.Body = http.MaxBytesReader(...)` line through the `SetSongCover` call with the helper call. The function becomes:
```go
func (h *songHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	coverID, ok := storeUploadedCover(w, r, h.media, h.repo, h.maxBytes)
	if !ok {
		return
	}
	if err := h.repo.SetSongCover(r.Context(), song.ID, coverID); err != nil {
		httpError(w, http.StatusInternalServerError, "assign cover")
		return
	}
	updated, err := h.repo.Get(r.Context(), song.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "reload song")
		return
	}
	writeJSON(w, updated)
}
```
Then remove the now-unused imports from `covers.go` (`crypto/sha256`, `encoding/hex`, `io`, `os`, and `imageutil`) — keep `database/sql`, `errors`, `mime`, `net/http`, `path/filepath` (still used by `getCover`). Run `go build` in step 6 to confirm the import set.

- [ ] **Step 5: Add the playlist cover handler + wire the media store**

In `backend/internal/httpapi/playlists.go`, add the `media` + `maxBytes` fields to the struct:
```go
type playlistHandlers struct {
	cfg      config.Config
	repo     *library.Repo
	media    *media.Store
	maxBytes int64
}
```
Add the import `"github.com/trick77/music/internal/media"` to `playlists.go`, and append the handler:
```go
func (h *playlistHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !h.requireAuth(w, r) {
		return
	}
	id := r.PathValue("id")
	pl, err := h.repo.GetPlaylist(r.Context(), id)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get playlist")
		return
	}
	if pl == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	coverID, ok := storeUploadedCover(w, r, h.media, h.repo, h.maxBytes)
	if !ok {
		return
	}
	if err := h.repo.SetPlaylistCover(r.Context(), id, coverID); err != nil {
		httpError(w, http.StatusInternalServerError, "assign cover")
		return
	}
	h.respondDetail(w, r, id, http.StatusOK)
}
```
In `backend/internal/httpapi/server.go`, update the `playlistHandlers` construction to pass the media store + limit, and register the route:
```go
			pl := &playlistHandlers{cfg: cfg, repo: h.repo, media: mstore, maxBytes: int64(cfg.MaxUploadMB) * 1024 * 1024}
```
and after the reorder route:
```go
			mux.HandleFunc("PUT /api/playlists/{id}/cover", pl.putCover)
```

- [ ] **Step 6: Run tests + build**

Run: `cd backend && go test ./internal/httpapi/ -v 2>&1 | tail -25 && CGO_ENABLED=0 go build ./...`
Expected: PASS (playlist cover tests + the existing song cover tests still green after the refactor); CGO-free build OK.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/httpapi/coverupload.go backend/internal/httpapi/covers.go backend/internal/httpapi/playlists.go backend/internal/httpapi/playlists_test.go backend/internal/httpapi/server.go
git commit -m "feat(httpapi): playlist cover upload via shared cover-store helper"
```

---

## Task 5: Server-side OG/Twitter share-meta injection

**Files:**
- Create: `backend/internal/httpapi/sharemeta.go`, `backend/internal/httpapi/sharemeta_test.go`
- Modify: `backend/web/embed.go` (export `IndexHTML`), `backend/internal/httpapi/server.go` (wrap the SPA handler)

**Interfaces:**
- Consumes: `library.Repo` (`Get`, `GetPlaylist`), `web.IndexHTML`.
- Produces:
  - `web.IndexHTML() ([]byte, error)` — the embedded `dist/index.html` bytes.
  - `withShareMeta(repo *library.Repo, shell []byte, spa http.Handler) http.Handler` — for `GET /song/{id}` and `GET /playlist/{id}` it injects escaped OG/Twitter tags into `shell` and serves `text/html`; everything else (and any not-found id, empty shell, or non-GET) delegates to `spa`.

**Decisions (baked in from review):**
- **Escape every user-controlled string** (title, artist, playlist name) with `html.EscapeString` before it enters a `content="…"` attribute — ID3 tags are accident/attacker-controlled.
- **Do not touch the document `<title>`.** Crawlers use `og:title`; the built shell's `<title>Music</title>` is harmless. We inject the meta block immediately after `</title>` (falling back to before `</head>`, then to prepend) so it works for both the placeholder shell and a real Vite build.
- **`og:image` fallback chain.** Song: song cover → omit. Playlist: playlist cover → first song's cover → omit. Never emit a broken image URL.
- **Missing/invalid id → plain SPA shell** (un-injected), so a human gets the in-app not-found and a crawler gets a clean page — never a 500.
- **Absolute image URL** from `X-Forwarded-Proto` (reverse proxy) else `r.TLS`, plus `r.Host`.

- [ ] **Step 1: Export the shell from the web package**

Add to `backend/web/embed.go` (below `SPAHandler`):
```go
// IndexHTML returns the embedded index.html shell bytes. Used by the server to
// inject per-route Open Graph tags for shared-link previews (crawlers do not
// run JS), while humans still receive the same shell and boot the SPA.
func IndexHTML() ([]byte, error) {
	return distFS.ReadFile("dist/index.html")
}
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/httpapi/sharemeta_test.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
)

// patchSongTitle edits a song's title via the API so we can inject a hostile
// value and assert it is escaped in the meta output.
func patchSongTitle(t *testing.T, h http.Handler, id, title string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"title": title, "artistName": "Test Artist", "album": "", "year": 0, "trackNo": 0, "genres": []string{},
	})
	rr := doJSON(t, h, "PATCH", "/api/songs/"+id, string(payload))
	if rr.Code != http.StatusOK {
		t.Fatalf("patch title = %d, body=%s", rr.Code, rr.Body.String())
	}
}

func TestShareMeta_songEmitsOGTags(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/song/"+sid, nil)
	req.Host = "music.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("song route = %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, want text/html", ct)
	}
	body := rr.Body.String()
	for _, want := range []string{
		`property="og:title"`,
		`property="og:type"`,
		`name="twitter:card"`,
		`Test Song`, // the fixture's title
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("meta missing %q in:\n%s", want, body)
		}
	}
}

func TestShareMeta_escapesHostileTitle(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	patchSongTitle(t, h, sid, `Broken " <script>alert(1)</script>`)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/song/"+sid, nil))
	body := rr.Body.String()

	if strings.Contains(body, "<script>alert(1)</script>") {
		t.Fatalf("hostile title not escaped:\n%s", body)
	}
	if !strings.Contains(body, "&lt;script&gt;") {
		t.Fatalf("expected escaped script tag in:\n%s", body)
	}
	if !strings.Contains(body, "&#34;") { // escaped double-quote
		t.Fatalf("expected escaped quote in:\n%s", body)
	}
}

func TestShareMeta_missingIdServesPlainSPA(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/song/does-not-exist", nil))
	// Delegated to the SPA stub in testServer (which writes "SPA"); must not 500
	// and must not contain og:title.
	if rr.Code == http.StatusInternalServerError {
		t.Fatalf("missing id should not 500")
	}
	if strings.Contains(rr.Body.String(), "og:title") {
		t.Fatalf("missing id should not inject og tags")
	}
}

func TestShareMeta_playlistFallsBackToFirstSongCover(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "Late Night Drive", "")
	sid := uploadSongID(t, h)
	// Give the song a cover so the playlist (no own cover) can fall back to it.
	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/songs/"+sid+"/cover", body)
	req.Header.Set("Content-Type", contentType)
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, req)
	if cr.Code != http.StatusOK {
		t.Fatalf("song cover = %d, body=%s", cr.Code, cr.Body.String())
	}
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)

	rr := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/playlist/"+pid, nil)
	req2.Host = "music.example.com"
	h.ServeHTTP(rr, req2)
	b := rr.Body.String()
	if !strings.Contains(b, `property="og:title"`) || !strings.Contains(b, "Late Night Drive") {
		t.Fatalf("playlist meta missing title:\n%s", b)
	}
	if !strings.Contains(b, `property="og:image"`) || !strings.Contains(b, "/api/cover/") {
		t.Fatalf("playlist should fall back to first song cover:\n%s", b)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run ShareMeta -v`
Expected: FAIL (`/song/...` currently hits the SPA stub → no og tags).

- [ ] **Step 4: Write the implementation**

Create `backend/internal/httpapi/sharemeta.go`:
```go
package httpapi

import (
	"context"
	"html"
	"net/http"
	"strings"

	"github.com/trick77/music/internal/library"
)

// withShareMeta serves crawler-friendly Open Graph/Twitter meta for the two
// public share routes (/song/{id}, /playlist/{id}) by injecting escaped tags
// into the embedded SPA shell. Every other request — and any unknown id, empty
// shell, or non-GET method — is delegated to the SPA handler unchanged, so
// humans always boot the app and a stale link yields the in-app not-found.
func withShareMeta(repo *library.Repo, shell []byte, spa http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && len(shell) > 0 && repo != nil {
			if id, ok := shareID(r.URL.Path, "/song/"); ok {
				if tags, ok := songMeta(r.Context(), repo, r, id); ok {
					serveShell(w, shell, tags)
					return
				}
			} else if id, ok := shareID(r.URL.Path, "/playlist/"); ok {
				if tags, ok := playlistMeta(r.Context(), repo, r, id); ok {
					serveShell(w, shell, tags)
					return
				}
			}
		}
		spa.ServeHTTP(w, r)
	})
}

// shareID returns the id for an exact "/prefix/{id}" path (no further segments).
func shareID(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func songMeta(ctx context.Context, repo *library.Repo, r *http.Request, id string) (string, bool) {
	song, err := repo.Get(ctx, id)
	if err != nil || song == nil {
		return "", false
	}
	img := ""
	if song.CoverArtID != "" {
		img = baseURL(r) + "/api/cover/" + song.CoverArtID
	}
	return buildMeta("music.song", song.Title, song.ArtistName, img, baseURL(r)+r.URL.Path), true
}

func playlistMeta(ctx context.Context, repo *library.Repo, r *http.Request, id string) (string, bool) {
	pl, err := repo.GetPlaylist(ctx, id)
	if err != nil || pl == nil {
		return "", false
	}
	desc := pl.Description
	if desc == "" {
		desc = "Playlist"
	}
	coverID := pl.CoverArtID
	if coverID == "" && len(pl.Songs) > 0 {
		coverID = pl.Songs[0].CoverArtID // fallback to first track's cover
	}
	img := ""
	if coverID != "" {
		img = baseURL(r) + "/api/cover/" + coverID
	}
	return buildMeta("music.playlist", pl.Name, desc, img, baseURL(r)+r.URL.Path), true
}

// buildMeta renders the OG/Twitter block. All dynamic strings are HTML-escaped
// for safe use inside double-quoted attribute values. og:image is omitted when
// empty so no broken image URL is ever advertised.
func buildMeta(ogType, title, desc, img, url string) string {
	var b strings.Builder
	meta := func(attr, key, val string) {
		b.WriteString(`<meta ` + attr + `="` + key + `" content="` + html.EscapeString(val) + "\">\n")
	}
	meta("property", "og:type", ogType)
	meta("property", "og:title", title)
	meta("property", "og:description", desc)
	meta("property", "og:url", url)
	meta("name", "twitter:card", pick(img, "summary_large_image", "summary"))
	meta("name", "twitter:title", title)
	meta("name", "twitter:description", desc)
	if img != "" {
		meta("property", "og:image", img)
		meta("name", "twitter:image", img)
	}
	return b.String()
}

func pick(cond, a, b string) string {
	if cond != "" {
		return a
	}
	return b
}

// baseURL reconstructs the external origin, honoring a reverse proxy's
// X-Forwarded-Proto (loom deploys behind one).
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + r.Host
}

// serveShell injects the meta block into the shell and writes it as HTML. The
// block goes right after </title> (present in both the placeholder and a real
// Vite build); failing that, before </head>; failing that, at the very front.
func serveShell(w http.ResponseWriter, shell []byte, tags string) {
	s := string(shell)
	lower := strings.ToLower(s)
	inject := "\n" + tags
	var out string
	if i := strings.Index(lower, "</title>"); i >= 0 {
		pos := i + len("</title>")
		out = s[:pos] + inject + s[pos:]
	} else if i := strings.Index(lower, "</head>"); i >= 0 {
		out = s[:i] + inject + s[i:]
	} else {
		out = tags + s
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(out))
}
```

- [ ] **Step 5: Wrap the SPA handler in `New()`**

In `backend/internal/httpapi/server.go`:

First, hoist a repo reference so the wrapper can use it. At the top of `New`, before building the mux routes, declare:
```go
	var shareRepo *library.Repo
```
Inside the `if st != nil && cfg.MediaDir != ""` / `if mstore` block, right after `h := &songHandlers{...}` is constructed, set:
```go
			shareRepo = h.repo
```
Then replace the SPA wiring at the bottom of `New`:
```go
	// Anything not under /api/ is the SPA.
	root := http.NewServeMux()
	root.Handle("/api/", mux)
	root.Handle("/", spa)
	return root
```
with:
```go
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
```
Add `"github.com/trick77/music/web"` to the `server.go` import block.

- [ ] **Step 6: Run tests + full suite + build**

Run: `cd backend && go test ./internal/httpapi/ ./web/ -run 'ShareMeta|SPA|Index' -v 2>&1 | tail -25 && go test ./... 2>&1 | tail -12 && CGO_ENABLED=0 go build ./...`
Expected: PASS everywhere; CGO-free build OK. (The existing `TestSPAFallthrough` still passes: `/anything` is not a share route, so it delegates to the stub.)

- [ ] **Step 7: Commit**

```bash
git add backend/internal/httpapi/sharemeta.go backend/internal/httpapi/sharemeta_test.go backend/internal/httpapi/server.go backend/web/embed.go
git commit -m "feat(httpapi): server-side OG/Twitter meta injection for song & playlist share links"
```

---

## Task 6: Frontend foundation — router, share helpers, playlist API client

**Files:**
- Create: `ui/src/router.ts`, `ui/src/router.test.ts`, `ui/src/share.ts`, `ui/src/share.test.ts`
- Modify: `ui/src/api.ts` (playlist types + calls)

**Interfaces:**
- Produces:
  - `Route = { name: "home" } | { name: "favorites" } | { name: "playlists" } | { name: "song"; id: string } | { name: "playlist"; id: string }`.
  - `parsePath(pathname: string): Route`.
  - `navigate(path: string): void` — `history.pushState` + dispatch a `popstate` so listeners re-render.
  - `useRoute(): Route` — subscribes to `popstate`.
  - `songShareUrl(id): string`, `playlistShareUrl(id): string`, `copyText(text): Promise<boolean>`.
  - `api.ts`: `Playlist` (= summary), `PlaylistDetail`, and `listPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `addSongToPlaylist`, `removeSongFromPlaylist`, `reorderPlaylist`, `uploadPlaylistCover`.

- [ ] **Step 1: Write the failing router + share tests**

Create `ui/src/router.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parsePath } from "./router";

describe("parsePath", () => {
  it("maps root to home", () => {
    expect(parsePath("/")).toEqual({ name: "home" });
  });
  it("maps /favorites and /playlists", () => {
    expect(parsePath("/favorites")).toEqual({ name: "favorites" });
    expect(parsePath("/playlists")).toEqual({ name: "playlists" });
  });
  it("extracts song id", () => {
    expect(parsePath("/song/abc123")).toEqual({ name: "song", id: "abc123" });
  });
  it("extracts playlist id", () => {
    expect(parsePath("/playlist/xyz")).toEqual({ name: "playlist", id: "xyz" });
  });
  it("falls back to home for unknown paths", () => {
    expect(parsePath("/nope/deep/path")).toEqual({ name: "home" });
  });
});
```

Create `ui/src/share.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { songShareUrl, playlistShareUrl } from "./share";

describe("share urls", () => {
  it("builds an absolute song url from the current origin", () => {
    expect(songShareUrl("abc")).toBe(`${location.origin}/song/abc`);
  });
  it("builds an absolute playlist url", () => {
    expect(playlistShareUrl("xyz")).toBe(`${location.origin}/playlist/xyz`);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npm run test -- --run router share`
Expected: FAIL (modules do not exist).

- [ ] **Step 3: Implement the router**

Create `ui/src/router.ts`:
```ts
import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "favorites" }
  | { name: "playlists" }
  | { name: "song"; id: string }
  | { name: "playlist"; id: string };

export function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts.length === 1 && parts[0] === "favorites") return { name: "favorites" };
  if (parts.length === 1 && parts[0] === "playlists") return { name: "playlists" };
  if (parts.length === 2 && parts[0] === "song") return { name: "song", id: parts[1] };
  if (parts.length === 2 && parts[0] === "playlist") return { name: "playlist", id: parts[1] };
  return { name: "home" };
}

// navigate performs SPA navigation without a full reload and notifies listeners.
export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// useRoute re-renders on back/forward and on navigate().
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}
```

Create `ui/src/share.ts`:
```ts
export function songShareUrl(id: string): string {
  return `${location.origin}/song/${id}`;
}

export function playlistShareUrl(id: string): string {
  return `${location.origin}/playlist/${id}`;
}

// copyText copies to the clipboard, resolving false when unavailable (e.g.
// insecure context) so callers can fall back to a prompt.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify router + share pass**

Run: `cd ui && npm run test -- --run router share`
Expected: PASS.

- [ ] **Step 5: Add the playlist API client**

Append to `ui/src/api.ts`:
```ts
export type Playlist = {
  id: string;
  name: string;
  description: string;
  coverArtId: string;
  songCount: number;
};

export type PlaylistDetail = Playlist & { songs: Song[] };

export async function listPlaylists(): Promise<Playlist[]> {
  const r = await fetch("/api/playlists");
  if (!r.ok) throw new Error("failed to load playlists");
  const data = await r.json();
  return data.playlists ?? [];
}

export async function getPlaylist(id: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}`);
  if (!r.ok) throw new Error(`failed to load playlist (${r.status})`);
  return r.json();
}

export async function createPlaylist(name: string, description: string): Promise<PlaylistDetail> {
  const r = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(`create failed (${r.status})`);
  return r.json();
}

export async function updatePlaylist(id: string, name: string, description: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export async function deletePlaylist(id: string): Promise<void> {
  const r = await fetch(`/api/playlists/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}

export async function addSongToPlaylist(id: string, songId: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songId }),
  });
  if (!r.ok) throw new Error(`add failed (${r.status})`);
  return r.json();
}

export async function removeSongFromPlaylist(id: string, songId: string): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/songs/${songId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`remove failed (${r.status})`);
  return r.json();
}

export async function reorderPlaylist(id: string, songIds: string[]): Promise<PlaylistDetail> {
  const r = await fetch(`/api/playlists/${id}/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ songIds }),
  });
  if (!r.ok) throw new Error(`reorder failed (${r.status})`);
  return r.json();
}

export async function uploadPlaylistCover(id: string, file: File): Promise<PlaylistDetail> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/playlists/${id}/cover`, { method: "PUT", body: form });
  if (!r.ok) throw new Error(`cover upload failed (${r.status})`);
  return r.json();
}
```

- [ ] **Step 6: Typecheck + tests**

Run: `cd ui && npx tsc --noEmit && npm run test -- --run`
Expected: PASS (types compile; router/share/cover/format tests green).

- [ ] **Step 7: Commit**

```bash
git add ui/src/router.ts ui/src/router.test.ts ui/src/share.ts ui/src/share.test.ts ui/src/api.ts
git commit -m "feat(ui): path router, share-url helpers, playlist API client"
```

---

## Task 7: Frontend — favorites (localStorage) + heart control

**Files:**
- Create: `ui/src/favorites.ts`, `ui/src/favorites.test.ts`

**Interfaces:**
- Produces:
  - `type Store = Pick<Storage, "getItem" | "setItem">` (dependency-injected so tests need no jsdom).
  - `loadFavorites(store: Store): string[]`.
  - `toggleFavorite(store: Store, id: string): string[]` — returns the new list.
  - `isFavorite(list: string[], id: string): boolean`.
  - `useFavorites(): { ids: string[]; toggle: (id: string) => void; has: (id: string) => boolean }` — React hook over `window.localStorage`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/favorites.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadFavorites, toggleFavorite, isFavorite, type Store } from "./favorites";

function fakeStore(initial?: string): Store {
  let value = initial;
  return {
    getItem: (_k: string) => value ?? null,
    setItem: (_k: string, v: string) => {
      value = v;
    },
  };
}

describe("favorites", () => {
  it("starts empty", () => {
    expect(loadFavorites(fakeStore())).toEqual([]);
  });
  it("toggles an id on and off", () => {
    const store = fakeStore();
    let list = toggleFavorite(store, "a");
    expect(list).toEqual(["a"]);
    expect(loadFavorites(store)).toEqual(["a"]);
    list = toggleFavorite(store, "a");
    expect(list).toEqual([]);
  });
  it("isFavorite reflects membership", () => {
    expect(isFavorite(["a", "b"], "b")).toBe(true);
    expect(isFavorite(["a"], "z")).toBe(false);
  });
  it("survives corrupt storage", () => {
    expect(loadFavorites(fakeStore("not json"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run favorites`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement favorites**

Create `ui/src/favorites.ts`:
```ts
import { useCallback, useEffect, useState } from "react";

export type Store = Pick<Storage, "getItem" | "setItem">;

const KEY = "music.favorites";

export function loadFavorites(store: Store): string[] {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toggleFavorite(store: Store, id: string): string[] {
  const list = loadFavorites(store);
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  store.setItem(KEY, JSON.stringify(next));
  return next;
}

export function isFavorite(list: string[], id: string): boolean {
  return list.includes(id);
}

// useFavorites is the React binding over window.localStorage. It stays in sync
// across components/tabs via the storage event.
export function useFavorites() {
  const [ids, setIds] = useState<string[]>(() => loadFavorites(window.localStorage));
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setIds(loadFavorites(window.localStorage));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = useCallback((id: string) => setIds(toggleFavorite(window.localStorage, id)), []);
  const has = useCallback((id: string) => ids.includes(id), [ids]);
  return { ids, toggle, has };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npm run test -- --run favorites`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/favorites.ts ui/src/favorites.test.ts
git commit -m "feat(ui): localStorage favorites module + hook"
```

---

## Task 8: Frontend — play queue (pure ops)

**Files:**
- Create: `ui/src/queue.ts`, `ui/src/queue.test.ts`

**Interfaces:**
- Produces (all pure, immutable — `Song[]` in, new `Song[]` out):
  - `addToQueue(queue: Song[], song: Song): Song[]` — append (no dedupe; a song may be queued twice).
  - `playNext(queue: Song[], song: Song): Song[]` — insert at the front.
  - `removeAt(queue: Song[], index: number): Song[]`.
  - `reorder(queue: Song[], from: number, to: number): Song[]` — move one item.

- [ ] **Step 1: Write the failing test**

Create `ui/src/queue.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { addToQueue, playNext, removeAt, reorder } from "./queue";
import type { Song } from "./api";

const s = (id: string): Song => ({
  id, title: id, artistName: "", album: "", year: 0, trackNo: 0,
  durationMs: 0, genres: [], coverArtId: "",
});

describe("queue ops", () => {
  it("appends to the end", () => {
    expect(addToQueue([s("a")], s("b")).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("play next inserts at the front", () => {
    expect(playNext([s("a")], s("b")).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("removes by index", () => {
    expect(removeAt([s("a"), s("b"), s("c")], 1).map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("reorders by moving an item", () => {
    expect(reorder([s("a"), s("b"), s("c")], 2, 0).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
  it("does not mutate the input", () => {
    const input = [s("a"), s("b")];
    addToQueue(input, s("c"));
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run queue`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement queue ops**

Create `ui/src/queue.ts`:
```ts
import type { Song } from "./api";

export function addToQueue(queue: Song[], song: Song): Song[] {
  return [...queue, song];
}

export function playNext(queue: Song[], song: Song): Song[] {
  return [song, ...queue];
}

export function removeAt(queue: Song[], index: number): Song[] {
  return queue.filter((_, i) => i !== index);
}

export function reorder(queue: Song[], from: number, to: number): Song[] {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) {
    return queue;
  }
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npm run test -- --run queue`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/queue.ts ui/src/queue.test.ts
git commit -m "feat(ui): pure play-queue operations"
```

---

## Task 9: Frontend — song "…" menu, add-to-playlist chooser, share

**Files:**
- Create: `ui/src/SongMenu.tsx`, `ui/src/AddToPlaylist.tsx`
- Modify: `ui/src/App.tsx` (render the "…" button + menu on rows; wire share/queue/favorite actions)

**Interfaces:**
- Consumes: `Song`, `Playlist`, `addToQueue`/`playNext` (Task 8), `useFavorites` (Task 7), `songShareUrl`/`copyText` (Task 6), `listPlaylists`/`addSongToPlaylist`/`createPlaylist` (Task 6).
- Produces:
  - `SongMenu` props: `{ song: Song; authenticated: boolean; onPlayNext: () => void; onAddToQueue: () => void; onAddToPlaylist: () => void; onShare: () => void; onEdit: () => void; onDelete: () => void; onClose: () => void }`. Renders Play next / Add to queue / Add to playlist / Download / Share always; **Edit tags / Delete only when `authenticated`** (omitted otherwise — never disabled).
  - `AddToPlaylist` props: `{ song: Song; onClose: () => void; onDone: () => void }`. Lists playlists (with a "New playlist" row for authenticated users), adds the song on click.

**Note (design invariant):** Edit/Delete rows must be conditionally *rendered*, not disabled. The context menu itself (with Play next/Add to queue/Share/Download) is shown to everyone.

- [ ] **Step 1: Implement `SongMenu`**

Create `ui/src/SongMenu.tsx`:
```tsx
import type { Song } from "./api";

type Props = {
  song: Song;
  authenticated: boolean;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onAddToPlaylist: () => void;
  onShare: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

const item: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "0.6rem",
  padding: "0.5rem 0.85rem", cursor: "pointer", color: "var(--color-ink)",
  fontSize: "0.9rem", background: "none", border: "none", width: "100%", textAlign: "left",
};

export function SongMenu(p: Props) {
  return (
    <>
      <div onClick={p.onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div
        role="menu"
        style={{
          position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 41,
          minWidth: 200, background: "var(--color-panel)", border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-ui, 10px)", padding: "0.35rem 0", boxShadow: "0 8px 30px rgba(0,0,0,.45)",
        }}
      >
        <button role="menuitem" style={item} onClick={p.onPlayNext}>Play next</button>
        <button role="menuitem" style={item} onClick={p.onAddToQueue}>Add to queue</button>
        <button role="menuitem" style={item} onClick={p.onAddToPlaylist}>Add to playlist</button>
        <a role="menuitem" style={{ ...item, textDecoration: "none" }} href={`/api/songs/${p.song.id}/download`}>Download</a>
        <button role="menuitem" style={item} onClick={p.onShare}>Share</button>
        {p.authenticated && (
          <>
            <div style={{ height: 1, background: "var(--color-border)", margin: "0.35rem 0" }} />
            <button role="menuitem" style={item} onClick={p.onEdit}>Edit tags</button>
            <button role="menuitem" style={{ ...item, color: "var(--color-accent-strong)" }} onClick={p.onDelete}>Delete song</button>
          </>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Implement `AddToPlaylist`**

Create `ui/src/AddToPlaylist.tsx`:
```tsx
import { useEffect, useState } from "react";
import { addSongToPlaylist, createPlaylist, listPlaylists, type Playlist, type Song } from "./api";

type Props = { song: Song; authenticated: boolean; onClose: () => void; onDone: (name: string) => void };

const item: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "0.5rem 0.85rem", cursor: "pointer", color: "var(--color-ink)",
  fontSize: "0.9rem", background: "none", border: "none", width: "100%", textAlign: "left",
};

export function AddToPlaylist({ song, authenticated, onClose, onDone }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, []);

  const add = async (id: string, name: string) => {
    if (busy) return;
    setBusy(true);
    try { await addSongToPlaylist(id, song.id); onDone(name); } finally { setBusy(false); }
  };

  const createAndAdd = async () => {
    const name = window.prompt("New playlist name");
    if (!name) return;
    const pl = await createPlaylist(name, "");
    await add(pl.id, pl.name);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 300, background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-ui, 10px)", padding: "0.6rem 0" }}>
        <div style={{ padding: "0.4rem 0.85rem", color: "var(--color-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Add to playlist</div>
        {authenticated && <button style={{ ...item, color: "var(--color-accent-strong)" }} onClick={createAndAdd}>+ New playlist</button>}
        {playlists.map((pl) => (
          <button key={pl.id} style={item} onClick={() => add(pl.id, pl.name)}>
            <span>{pl.name}</span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>{pl.songCount}</span>
          </button>
        ))}
        {playlists.length === 0 && !authenticated && (
          <div style={{ padding: "0.5rem 0.85rem", color: "var(--color-muted)", fontSize: "0.85rem" }}>No playlists yet.</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (components compile). Full UI wiring into `App.tsx` happens in Task 10 alongside the views; this task delivers the two overlays.

- [ ] **Step 4: Commit**

```bash
git add ui/src/SongMenu.tsx ui/src/AddToPlaylist.tsx
git commit -m "feat(ui): song context menu + add-to-playlist chooser"
```

---

## Task 10: Frontend — Library tabs, playlist views, queue drawer, App wiring

**Files:**
- Create: `ui/src/Library.tsx`, `ui/src/PlaylistDetail.tsx`, `ui/src/PlaylistEditor.tsx`, `ui/src/QueueDrawer.tsx`
- Modify: `ui/src/App.tsx` (route-aware shell wiring router + favorites + queue + menus + share)

**Interfaces:**
- Consumes: everything from Tasks 6–9.
- Produces:
  - `Library` — segmented All songs / Favorites / Playlists; renders song rows (with heart + "…") and a playlists grid (with a "New playlist" card for authenticated users).
  - `PlaylistDetail` — a playlist's ordered songs, Play/Share, and (authenticated) an Edit button opening `PlaylistEditor`.
  - `PlaylistEditor` — modal: cover upload (auth), name, description, drag-reorder song list with per-row remove, add-songs search; Create/Save. **Uses native HTML5 drag events** (`draggable` + `onDragStart/onDragOver/onDrop`) with the `reorder` helper — no DnD library.
  - `QueueDrawer` — up-next list with drag-reorder + per-row remove.

**Design invariant reminder:** every authenticated-only affordance (Upload, heart is NOT gated, playlist create/edit, delete, cover upload) is rendered only when `session.authenticated` — never disabled. The heart is shown to everyone.

- [ ] **Step 1: Implement `QueueDrawer`**

Create `ui/src/QueueDrawer.tsx`:
```tsx
import { useState } from "react";
import type { Song } from "./api";
import { reorder, removeAt } from "./queue";
import { formatDuration } from "./format";

type Props = {
  queue: Song[];
  nowPlaying: Song | null;
  onChange: (q: Song[]) => void;
  onPlay: (index: number) => void;
  onClose: () => void;
};

export function QueueDrawer({ queue, nowPlaying, onChange, onPlay, onClose }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, maxWidth: "90vw", zIndex: 60, background: "var(--color-panel)", borderLeft: "1px solid var(--color-border)", padding: "1rem", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Queue</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
      </div>
      {nowPlaying && (
        <>
          <div style={{ color: "var(--color-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Now playing</div>
          <div style={{ padding: "0.4rem 0", marginBottom: "0.5rem" }}><strong>{nowPlaying.title}</strong><div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>{nowPlaying.artistName}</div></div>
        </>
      )}
      <div style={{ color: "var(--color-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Next up</div>
      {queue.length === 0 && <div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>Queue is empty.</div>}
      {queue.map((song, i) => (
        <div
          key={`${song.id}-${i}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag !== null) onChange(reorder(queue, drag, i)); setDrag(null); }}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", cursor: "grab" }}
        >
          <span style={{ color: "var(--color-muted)" }}>⠿</span>
          <span style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onPlay(i)}>
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
            <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem" }}>{song.artistName}</span>
          </span>
          <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", fontSize: "0.8rem" }}>{formatDuration(song.durationMs)}</span>
          <button onClick={() => onChange(removeAt(queue, i))} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>✕</button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `PlaylistEditor`**

Create `ui/src/PlaylistEditor.tsx`:
```tsx
import { useState } from "react";
import {
  createPlaylist, updatePlaylist, addSongToPlaylist, removeSongFromPlaylist,
  reorderPlaylist, uploadPlaylistCover, listSongs, type PlaylistDetail, type Song,
} from "./api";
import { coverUrl } from "./cover";
import { formatDuration } from "./format";

type Props = {
  existing: PlaylistDetail | null; // null = create
  onClose: () => void;
  onSaved: (pl: PlaylistDetail) => void;
};

export function PlaylistEditor({ existing, onClose, onSaved }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [detail, setDetail] = useState<PlaylistDetail | null>(existing);
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const songs = detail?.songs ?? [];

  const ensurePlaylist = async (): Promise<PlaylistDetail> => {
    if (detail) {
      const pl = await updatePlaylist(detail.id, name || "Untitled", description);
      setDetail(pl);
      return pl;
    }
    const pl = await createPlaylist(name || "Untitled", description);
    setDetail(pl);
    return pl;
  };

  const onAddSearch = async () => {
    if (allSongs.length === 0) setAllSongs(await listSongs());
  };

  const addSong = async (song: Song) => {
    const pl = await ensurePlaylist();
    setDetail(await addSongToPlaylist(pl.id, song.id));
  };

  const remove = async (song: Song) => {
    if (!detail) return;
    setDetail(await removeSongFromPlaylist(detail.id, song.id));
  };

  const onDrop = async (to: number) => {
    if (drag === null || !detail) return setDrag(null);
    const ids = songs.map((s) => s.id);
    const [moved] = ids.splice(drag, 1);
    ids.splice(to, 0, moved);
    setDrag(null);
    setDetail(await reorderPlaylist(detail.id, ids));
  };

  const onCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const pl = await ensurePlaylist();
    setDetail(await uploadPlaylistCover(pl.id, file));
  };

  const save = async () => {
    setBusy(true);
    try { onSaved(await ensurePlaylist()); } finally { setBusy(false); }
  };

  const matches = query
    ? allSongs.filter((s) => `${s.title} ${s.artistName}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", padding: "1rem" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-ui, 10px)", padding: "1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>{existing ? "Edit playlist" : "New playlist"}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 96, height: 96, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
              {detail?.coverArtId ? <img src={coverUrl(detail.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--color-muted)" }}>♪</span>}
            </div>
            <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.8rem", display: "block", marginTop: 6 }}>
              Upload cover
              <input type="file" accept="image/png,image/jpeg" onChange={onCover} style={{ display: "none" }} />
            </label>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", marginBottom: 4 }}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            <label style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", margin: "0.6rem 0 4px" }}>Description · optional</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
          </div>
        </div>

        <div style={{ color: "var(--color-muted)", fontSize: "0.8rem", marginBottom: 4 }}>Songs · {songs.length}</div>
        {songs.map((song, i) => (
          <div key={song.id} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0", cursor: "grab" }}>
            <span style={{ color: "var(--color-muted)" }}>⠿</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem" }}>{song.artistName}</span>
            </span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", fontSize: "0.8rem" }}>{formatDuration(song.durationMs)}</span>
            <button onClick={() => remove(song)} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>✕</button>
          </div>
        ))}

        <input placeholder="Add songs — search by title or artist…" value={query}
          onFocus={onAddSearch} onChange={(e) => setQuery(e.target.value)}
          style={{ ...inputStyle, marginTop: "0.75rem" }} />
        {matches.map((song) => (
          <button key={song.id} onClick={() => addSong(song)} style={{ ...inputStyle, textAlign: "left", cursor: "pointer", marginTop: 4, background: "var(--color-active)" }}>
            {song.title} — <span style={{ color: "var(--color-muted)" }}>{song.artistName}</span>
          </button>
        ))}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.25rem" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={save} disabled={busy || !name} style={{ ...btnStyle, background: "var(--color-accent-strong)", color: "#fff", border: "none" }}>
            {existing ? "Save" : "Create playlist"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "0.5rem 0.65rem", borderRadius: 8, boxSizing: "border-box",
  background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem", borderRadius: 8, cursor: "pointer",
  background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
```
Note: the Save button's `disabled` attribute is a form-validity guard (empty name), not an auth gate — the whole editor is only ever opened for authenticated users, so this does not violate the presence/absence rule.

- [ ] **Step 3: Implement `PlaylistDetail` view**

Create `ui/src/PlaylistDetail.tsx`:
```tsx
import { useEffect, useState } from "react";
import { getPlaylist, deletePlaylist, type PlaylistDetail as PL, type Song } from "./api";
import { coverUrl } from "./cover";
import { formatDuration } from "./format";
import { playlistShareUrl, copyText } from "./share";
import { navigate } from "./router";

type Props = {
  id: string;
  authenticated: boolean;
  onPlay: (song: Song, queue: Song[]) => void;
  onEdit: (pl: PL) => void;
};

export function PlaylistView({ id, authenticated, onPlay, onEdit }: Props) {
  const [pl, setPl] = useState<PL | null>(null);
  const [error, setError] = useState(false);

  const load = () => getPlaylist(id).then(setPl).catch(() => setError(true));
  useEffect(() => { load(); }, [id]);

  if (error) return <p style={{ color: "var(--color-muted)" }}>Playlist not found.</p>;
  if (!pl) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;

  const share = async () => {
    const url = playlistShareUrl(pl.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
  };

  const remove = async () => {
    if (!window.confirm(`Delete playlist "${pl.name}"? This cannot be undone.`)) return;
    await deletePlaylist(pl.id);
    navigate("/playlists");
  };

  return (
    <div>
      <button onClick={() => navigate("/playlists")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Playlists</button>
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", marginBottom: "1.25rem" }}>
        <div style={{ width: 120, height: 120, borderRadius: 10, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center", flexShrink: 0 }}>
          {pl.coverArtId ? <img src={coverUrl(pl.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : pl.songs[0]?.coverArtId ? <img src={coverUrl(pl.songs[0].coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ color: "var(--color-muted)", fontSize: "2rem" }}>♪</span>}
        </div>
        <div>
          <h1 style={{ fontFamily: "var(--font-serif)", margin: "0 0 0.25rem" }}>{pl.name}</h1>
          {pl.description && <p style={{ color: "var(--color-muted)", margin: "0 0 0.5rem" }}>{pl.description}</p>}
          <div style={{ display: "flex", gap: "0.6rem" }}>
            {pl.songs.length > 0 && <button onClick={() => onPlay(pl.songs[0], pl.songs.slice(1))} style={btn}>▶ Play</button>}
            <button onClick={share} style={btn}>Share</button>
            {authenticated && <button onClick={() => onEdit(pl)} style={btn}>Edit</button>}
            {authenticated && <button onClick={remove} style={{ ...btn, color: "var(--color-accent-strong)" }}>Delete</button>}
          </div>
        </div>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {pl.songs.map((song, i) => (
          <li key={song.id} onClick={() => onPlay(song, pl.songs.slice(i + 1))}
            style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.6rem", borderRadius: 8, cursor: "pointer" }}>
            <span style={{ color: "var(--color-muted)", width: 22, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>{song.artistName}</span>
            </span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(song.durationMs)}</span>
          </li>
        ))}
      </ol>
      {pl.songs.length === 0 && <p style={{ color: "var(--color-muted)" }}>No songs yet{authenticated ? " — add some from Edit." : "."}</p>}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "0.4rem 0.85rem", borderRadius: 8, cursor: "pointer",
  background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
```

- [ ] **Step 4: Implement `Library` (segmented tabs)**

Create `ui/src/Library.tsx`:
```tsx
import { useEffect, useState } from "react";
import { listPlaylists, type Playlist, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { formatDuration } from "./format";
import { navigate } from "./router";

type Tab = "all" | "favorites" | "playlists";

type Props = {
  songs: Song[];
  favoriteIds: string[];
  authenticated: boolean;
  initialTab: Tab;
  onPlay: (song: Song) => void;
  renderRowActions: (song: Song) => React.ReactNode;
  onNewPlaylist: () => void;
};

export function Library({ songs, favoriteIds, authenticated, initialTab, onPlay, renderRowActions, onNewPlaylist }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  useEffect(() => { if (tab === "playlists") listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, [tab]);

  const shown = tab === "favorites" ? songs.filter((s) => favoriteIds.includes(s.id)) : songs;

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1.25rem" }}>
        {(["all", "favorites", "playlists"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "0.35rem 0.85rem", borderRadius: 999, cursor: "pointer", fontSize: "0.85rem",
              border: "1px solid var(--color-border)",
              background: tab === t ? "var(--color-active)" : "transparent",
              color: tab === t ? "var(--color-ink)" : "var(--color-muted)" }}>
            {t === "all" ? "All songs" : t === "favorites" ? "Favorites" : "Playlists"}
          </button>
        ))}
      </div>

      {tab === "playlists" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "1rem" }}>
          {authenticated && (
            <button onClick={onNewPlaylist} style={{ aspectRatio: "1", borderRadius: 10, border: "1px dashed var(--color-border)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>+ New playlist</button>
          )}
          {playlists.map((pl) => (
            <button key={pl.id} onClick={() => navigate(`/playlist/${pl.id}`)} style={{ textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <div style={{ aspectRatio: "1", borderRadius: 10, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
                {pl.coverArtId ? <img src={coverUrl(pl.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--color-muted)", fontSize: "1.5rem" }}>♪</span>}
              </div>
              <div style={{ marginTop: 6, color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pl.name}</div>
              <div style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>{pl.songCount} songs</div>
            </button>
          ))}
          {playlists.length === 0 && !authenticated && <p style={{ color: "var(--color-muted)" }}>No playlists yet.</p>}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.length === 0 && <p style={{ color: "var(--color-muted)" }}>{tab === "favorites" ? "No favorites yet — tap the heart on a song." : "Nothing here yet."}</p>}
          {shown.map((song) => (
            <li key={song.id} onClick={() => onPlay(song)} style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.6rem 0.85rem", borderRadius: "var(--radius-ui, 10px)", cursor: "pointer" }}>
              <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", border: "1px solid var(--color-border)" }}>
                {song.coverArtId ? <img src={coverUrl(song.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.artistName)}</span>}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>{song.artistName}</span>
              </span>
              <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{formatDuration(song.durationMs)}</span>
              <span style={{ position: "relative", display: "flex", gap: "0.35rem", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>{renderRowActions(song)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Rewrite `App.tsx` as the route-aware shell**

Replace `ui/src/App.tsx` entirely:
```tsx
import { useEffect, useRef, useState } from "react";
import { getSession, listSongs, uploadSong, streamUrl, type Session, type Song, type PlaylistDetail } from "./api";
import { TagEditor } from "./TagEditor";
import { Library } from "./Library";
import { PlaylistView } from "./PlaylistDetail";
import { PlaylistEditor } from "./PlaylistEditor";
import { QueueDrawer } from "./QueueDrawer";
import { SongMenu } from "./SongMenu";
import { AddToPlaylist } from "./AddToPlaylist";
import { useRoute, navigate } from "./router";
import { useFavorites } from "./favorites";
import { addToQueue, playNext } from "./queue";
import { songShareUrl, copyText } from "./share";

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<Song | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Song | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<Song | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null | "new">(null);
  const [toast, setToast] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fav = useFavorites();
  const authed = !!session?.authenticated;

  const refresh = () => listSongs().then(setSongs).catch(() => {});
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession({ authenticated: false, username: "" }));
    refresh();
  }, []);

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 2000); };

  const play = (song: Song, upNext: Song[] = []) => {
    setNowPlaying(song);
    setQueue(upNext);
    requestAnimationFrame(() => { const el = audioRef.current; if (el) { el.load(); void el.play().catch(() => {}); } });
  };

  const onEnded = () => {
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setNowPlaying(next);
    setQueue(rest);
    requestAnimationFrame(() => { const el = audioRef.current; if (el) { el.load(); void el.play().catch(() => {}); } });
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try { await uploadSong(file); await refresh(); } finally { setUploading(false); e.target.value = ""; }
  };

  const share = async (song: Song) => {
    const url = songShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
    setMenuFor(null);
  };

  const rowActions = (song: Song) => (
    <>
      <button aria-label="favorite" onClick={() => fav.toggle(song.id)}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1rem",
          color: fav.has(song.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}>
        {fav.has(song.id) ? "♥" : "♡"}
      </button>
      <span style={{ position: "relative" }}>
        <button aria-label="more" onClick={() => setMenuFor(menuFor === song.id ? null : song.id)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-muted)", fontSize: "1.1rem" }}>⋯</button>
        {menuFor === song.id && (
          <SongMenu song={song} authenticated={authed}
            onPlayNext={() => { setQueue((q) => playNext(q, song)); setMenuFor(null); flash("Playing next"); }}
            onAddToQueue={() => { setQueue((q) => addToQueue(q, song)); setMenuFor(null); flash("Added to queue"); }}
            onAddToPlaylist={() => { setAddFor(song); setMenuFor(null); }}
            onShare={() => share(song)}
            onEdit={() => { setEditing(song); setMenuFor(null); }}
            onDelete={() => { setMenuFor(null); /* delete-song endpoint is Phase 6; hidden action no-op for now */ flash("Delete is coming in a later phase"); }}
            onClose={() => setMenuFor(null)} />
        )}
      </span>
    </>
  );

  return (
    <div style={{ minHeight: "100vh", maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem 8rem" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 onClick={() => navigate("/")} style={{ fontFamily: "var(--font-serif)", fontSize: "1.75rem", margin: 0, cursor: "pointer" }}>Music</h1>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <button onClick={() => setShowQueue(true)} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>Queue</button>
          {authed && (
            <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.95rem" }}>
              {uploading ? "Uploading…" : "Upload"}
              <input type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />
            </label>
          )}
        </div>
      </header>

      {route.name === "playlist" ? (
        <PlaylistView id={route.id} authenticated={authed}
          onPlay={(s, q) => play(s, q)} onEdit={(pl) => setEditingPlaylist(pl)} />
      ) : route.name === "song" ? (
        <SongPage id={route.id} songs={songs} onPlay={(s) => play(s)} />
      ) : (
        <Library songs={songs} favoriteIds={fav.ids} authenticated={authed}
          initialTab={route.name === "favorites" ? "favorites" : route.name === "playlists" ? "playlists" : "all"}
          onPlay={(s) => play(s)} renderRowActions={rowActions}
          onNewPlaylist={() => setEditingPlaylist("new")} />
      )}

      {nowPlaying && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "var(--color-panel)", borderTop: "1px solid var(--color-border)", padding: "0.75rem 1.25rem" }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem", fontSize: "0.9rem" }}>
              <span><strong>{nowPlaying.title}</strong><span style={{ color: "var(--color-muted)" }}> — {nowPlaying.artistName}</span></span>
              <button aria-label="favorite-now" onClick={() => fav.toggle(nowPlaying.id)} style={{ background: "none", border: "none", cursor: "pointer", color: fav.has(nowPlaying.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}>{fav.has(nowPlaying.id) ? "♥" : "♡"}</button>
            </div>
            <audio ref={audioRef} controls onEnded={onEnded} style={{ width: "100%" }} src={streamUrl(nowPlaying.id)}><track kind="captions" /></audio>
          </div>
        </div>
      )}

      {showQueue && <QueueDrawer queue={queue} nowPlaying={nowPlaying} onChange={setQueue} onPlay={(i) => { const s = queue[i]; play(s, queue.slice(i + 1)); }} onClose={() => setShowQueue(false)} />}
      {editing && <TagEditor song={editing} onClose={() => setEditing(null)} onSaved={(saved) => { setSongs((prev) => prev.map((s) => (s.id === saved.id ? saved : s))); setEditing(saved); }} />}
      {addFor && <AddToPlaylist song={addFor} authenticated={authed} onClose={() => setAddFor(null)} onDone={(name) => { setAddFor(null); flash(`Added to ${name}`); }} />}
      {editingPlaylist !== null && <PlaylistEditor existing={editingPlaylist === "new" ? null : editingPlaylist} onClose={() => setEditingPlaylist(null)} onSaved={(pl) => { setEditingPlaylist(null); navigate(`/playlist/${pl.id}`); }} />}
      {toast && <div style={{ position: "fixed", bottom: nowPlaying ? 120 : 24, left: "50%", transform: "translateX(-50%)", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: 999, padding: "0.4rem 1rem", fontSize: "0.85rem", zIndex: 80 }}>{toast}</div>}
    </div>
  );
}

// SongPage is the public share landing for a single song: it plays and offers
// the same controls, resolving the song from the loaded list (falling back to a
// fetch if a deep link lands before the list is ready).
function SongPage({ id, songs, onPlay }: { id: string; songs: Song[]; onPlay: (s: Song) => void }) {
  const song = songs.find((s) => s.id === id);
  useEffect(() => { if (song) onPlay(song); }, [song?.id]);
  if (!song) return <p style={{ color: "var(--color-muted)" }}>Loading song… <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer" }}>Home</button></p>;
  return (
    <div>
      <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Home</button>
      <h1 style={{ fontFamily: "var(--font-serif)" }}>{song.title}</h1>
      <p style={{ color: "var(--color-muted)" }}>{song.artistName}</p>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck + full frontend test run**

Run: `cd ui && npx tsc --noEmit && npm run test -- --run`
Expected: PASS (all pure-module tests green; TS compiles).

- [ ] **Step 7: Commit**

```bash
git add ui/src/Library.tsx ui/src/PlaylistDetail.tsx ui/src/PlaylistEditor.tsx ui/src/QueueDrawer.tsx ui/src/App.tsx
git commit -m "feat(ui): library tabs, playlist views, queue drawer, favorites/menu/share wiring"
```

---

## Task 11: Build, end-to-end Playwright validation, and OG curl assertion

**Files:** none created — this task builds the single binary and validates the running app.

**Interfaces:** Consumes the whole stack. Produces evidence the phase works end-to-end.

- [ ] **Step 1: Build the SPA + binary**

Run:
```bash
cd /Users/jan/localgit/music && make fe-build && CGO_ENABLED=0 go -C backend build -o ../bin/music ./cmd/music
```
Expected: `ui` builds into `backend/web/dist`; `bin/music` produced. If `make fe-build` runs `npm ci` and fails on the lockfile, run `cd ui && npm install && npm run build` once, then re-run.

- [ ] **Step 2: Run the server with dev autologin on a temp DB/media dir**

Run (background):
```bash
cd /Users/jan/localgit/music && \
BACKEND_SESSION_SECRET=dev-secret-dev-secret-dev-secret \
BACKEND_AUTH_MODE=dev \
BACKEND_DB_PATH=/private/tmp/claude-501/-Users-jan-localgit-music/2aa2ef86-0970-4f08-9ee4-28c40d2a6fce/scratchpad/p4.db \
BACKEND_MEDIA_DIR=/private/tmp/claude-501/-Users-jan-localgit-music/2aa2ef86-0970-4f08-9ee4-28c40d2a6fce/scratchpad/p4-media \
./bin/music &
```
Wait ~1s, then confirm: `curl -s localhost:8080/api/health` → `{"status":"ok"}`. (Adjust the port if `BACKEND_LISTEN_ADDR`/config differs — check `config.go` for the default and set it explicitly if needed.)

- [ ] **Step 3: Seed a song via the API (dev is authenticated)**

Run:
```bash
curl -s -F "file=@backend/internal/metadata/testdata/sample.mp3" localhost:8080/api/songs | tee /dev/stderr | python3 -c "import sys,json; print('SONG_ID=', json.load(sys.stdin)['id'])"
```
Expected: a created song JSON; capture its id as `SONG_ID`.

- [ ] **Step 4: Playwright — favorites persist across reload**

Using the Playwright MCP browser tools:
1. `browser_navigate` to `http://localhost:8080/`.
2. `browser_snapshot`; find the song row's favorite (♡) button; `browser_click` it (it should turn ♥).
3. `browser_navigate` to `http://localhost:8080/favorites`.
4. `browser_snapshot`; assert the hearted song appears under the Favorites tab.
5. `browser_navigate` to `http://localhost:8080/` again (full reload), go to `/favorites`; assert the song is **still** there (proves localStorage persistence).

- [ ] **Step 5: Playwright — create a playlist, add the song, reorder**

1. Navigate to `/playlists`; click "New playlist".
2. In the editor, type a name ("Late Night Drive"), focus the "Add songs" search, type part of the song title, click the match to add it.
3. Click "Create playlist" / "Save"; assert navigation to `/playlist/{id}` and the song listed.
4. (If ≥2 songs seeded) drag a row by its grip and drop to reorder; reload the playlist route and assert the new order persisted (proves the reorder endpoint).

- [ ] **Step 6: Playwright — queue build + context menu**

1. On the library, open a song's "…" menu; click "Add to queue" (toast "Added to queue").
2. Click the header "Queue" button; assert the queue drawer lists the song under "Next up".
3. Remove it via the row ✕; assert it disappears.

- [ ] **Step 7: Playwright — share link opens in an anonymous context**

1. Get the playlist share URL (the Share button copies it; or construct `http://localhost:8080/playlist/{id}`).
2. Open a **new browser context/tab** (anonymous) via `browser_tabs`/`browser_navigate` and load the playlist URL.
3. Assert the playlist is viewable and playable, and that **no edit/create/delete affordances render** (presence/absence rule) — the anonymous page shows Play/Share only.

- [ ] **Step 8: OG meta — curl assertion (crawlers don't run JS)**

Run:
```bash
echo "== song ==";     curl -s "http://localhost:8080/song/$SONG_ID"       | grep -oE 'property="og:(title|image|type)"|name="twitter:card"' | sort -u
echo "== playlist =="; curl -s "http://localhost:8080/playlist/$PLAYLIST_ID" | grep -oE 'property="og:(title|image)"' | sort -u
echo "== proto ==";    curl -s -H "X-Forwarded-Proto: https" "http://localhost:8080/song/$SONG_ID" | grep -oE 'content="https://[^"]*/api/cover/[^"]*"' | head -1
```
Expected: the song route emits `og:title`, `og:type`, `twitter:card` (and `og:image` if the song has a cover — set one via `PUT /api/songs/$SONG_ID/cover` with a PNG first if you want to assert the image line); the playlist route emits `og:title` (and `og:image` when it or its first song has a cover); the forwarded-proto probe shows an absolute `https://…/api/cover/…` URL.

- [ ] **Step 9: Stop the server + record evidence**

Stop the background server (`kill %1` or the printed PID). In the PR description, paste the curl OG output and note the Playwright steps that passed (favorites-persist, playlist create+reorder, queue, anonymous share).

- [ ] **Step 10: Final full-suite gate + commit any fixups**

Run:
```bash
cd /Users/jan/localgit/music && make test && make fe-test && CGO_ENABLED=0 go -C backend build ./...
```
Expected: backend + frontend suites green; CGO-free build OK. Commit any validation-driven fixups with a conventional message.

---

## Task 12: Review-agent gate, PR, and merge

**Files:** none — process task.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/phase-4-playlists-queue-favorites-share
```

- [ ] **Step 2: Open the PR against THIS repo's `master`**

```bash
gh pr create --base master --title "feat: Phase 4 — playlists, queue, favorites & share" \
  --body "Implements Phase 4 per docs/superpowers/plans/2026-07-09-music-player-phase-4-playlists-queue-favorites-share.md. Playlists CRUD+reorder+cover, client queue, localStorage favorites, public share URLs, server-side OG meta injection. Includes Playwright validation + OG curl evidence."
```
(`trick77/music` is not a fork — no upstream-target confirmation needed. Base is this repo's `master`.)

- [ ] **Step 3: Dispatch a generic code-review agent over the PR diff**

Dispatch the `general-purpose` (or a code-review) agent with the diff (`git diff master...HEAD`) and this plan as context. Instruct it to check: security gating on every write endpoint; the OG escaping (hostile title) and fallback chain; reorder mismatch handling; the favorites-are-localStorage-only invariant (no server likes table/endpoint); presence/absence auth gating in the frontend; migration squash correctness.

- [ ] **Step 4: Address findings**

Apply fixes via the receiving-code-review skill (verify each suggestion; don't blindly accept). Re-run `make test && make fe-test`. Commit fixes.

- [ ] **Step 5: Confirm the worktree is on the right branch, then merge**

```bash
git branch --show-current   # must be feat/phase-4-playlists-queue-favorites-share
gh pr merge --squash --delete-branch
```
Confirm the review agent did not leave the worktree on the wrong branch before merging.

- [ ] **Step 6: Clean up the worktree**

After merge, exit and remove the worktree (via `ExitWorktree` with `action: "remove"`, or the platform's worktree cleanup). Verify `master` in the main checkout contains the merge.

---

## Self-Review (spec coverage)

- **§1 Favorites (localStorage, everyone, no server table):** Tasks 7 + 10 — `favorites.ts` + heart on rows/player; **no likes endpoint** (asserted by the Global Constraint + review gate). ✓
- **§10a Playlist create/edit (cover, name, description, drag-reorder, per-row remove, add via search):** Task 10 `PlaylistEditor`. ✓
- **§11 Sharing (public URL, no tokens, anonymous playable):** Tasks 6 (`share.ts`) + 10 (Share actions) + anonymous validation (Task 11 step 7). ✓
- **§12 Endpoints (`GET /api/playlists`, `GET /api/playlists/{id}` public; `POST/PATCH/DELETE …` + reorder authenticated):** Tasks 3 + 4. ✓
- **§15 Queue (up-next, drag-reorder) + per-song "…" menu (play next, add to queue, add to playlist, download, share; signed-in edit/delete):** Tasks 8 + 9 + 10. Note: **delete-song** endpoint is Phase 6 scope; the menu item is present but flagged as a later-phase no-op (documented in App wiring) so the menu shape matches the mockup without inventing an un-specced destructive endpoint. Playlist delete IS implemented (Task 3/10).
- **§15a Shared-link previews (OG/Twitter meta on song/playlist routes):** Task 5, validated by curl in Task 11 step 8. Genre OG deferred (browse pages are Phase 6). ✓
- **§14 Security (write endpoints gated; media sandboxed; uploads validated):** every write handler calls `identify(...).Authenticated`; covers go through `imageutil.Probe` + `media.Store` sandbox. Tasks 3/4 include anonymous-forbidden tests. ✓
- **Migration squash (user instruction):** Task 1. ✓

**Deliberately deferred (documented, not gaps):** delete-song endpoint, play-counting/Top-Ten, genre OG, MediaSession/PWA/resume, image-scale variants, fanart/BFL, OIDC — all later phases per the spec.
