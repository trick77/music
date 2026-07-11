# Song Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated user delete a song — behind a `../loom`-style confirmation dialog — removing the row (cascading to plays/playlist-entries/genre-links) and its audio file, and cleaning up player/queue state.

**Architecture:** A new `DELETE /api/songs/{id}` on the existing `songHandlers` calls a transactional `library.Repo.DeleteSong` that returns the audio path (for `media.Remove`) and whether the row existed. The React side adds a reusable `ConfirmDialog` (mirroring loom's `DeleteProjectModal`), a `deleteSong` API client, and a `player.remove(id)` helper; the already-present "Delete song" menu item's stub handler in `App.tsx` is wired to them.

**Tech Stack:** Go (net/http, database/sql, SQLite with FK enforcement), React + TypeScript (Vite, vitest, `renderToStaticMarkup`), inline `React.CSSProperties`.

## Global Constraints

- Backend `go test ./...` green (known-flaky `TestHomeFeed_recentNewestFirstWithLimit` is unrelated — ignore).
- Frontend `make fe-test` (`tsc` clean + vitest) green.
- SQLite FK enforcement is ON (`store.go`: `_pragma=foreign_keys(1)`), so a single `DELETE FROM songs` cascades to `plays`, `playlist_songs`, `song_genres`.
- **Cover art is never touched** by delete (shared per-album, content-hash-deduped, no ref-counting).
- Delete is **authed-only** (403 for anonymous). Missing song → **404**. Success → **204**.
- Dialog mirrors loom hexes as inline styles (the app has no Tailwind; it already hardcodes loom's menu hexes in `Menu.tsx`): panel `#383834`, border `#55524b`, ink `#f4f0e8`, body `#d5d2c9`, error `#d98278`, danger button `#d03b3b`→`#e34948`, cancel `rgba(255,255,255,0.10)`→`0.14`.
- All Read/Edit/Write target the worktree `/Users/jan/localgit/music/.claude/worktrees/feat+song-delete/`.

## File Structure

- Modify `backend/internal/library/songs.go` — add `DeleteSong`.
- Create `backend/internal/library/songs_delete_test.go` — repo cascade tests.
- Modify `backend/internal/httpapi/songs.go` — add `delete` handler.
- Modify `backend/internal/httpapi/server.go` — register `DELETE /api/songs/{id}`.
- Create `backend/internal/httpapi/songs_delete_test.go` — handler tests.
- Modify `ui/src/player.ts` — add exported `removeSong(state,id)` + `player.remove(id)`.
- Modify `ui/src/player.test.ts` — `removeSong` tests.
- Create `ui/src/ConfirmDialog.tsx` — reusable dialog.
- Create `ui/src/ConfirmDialog.test.tsx` — dialog render tests.
- Modify `ui/src/api.ts` — add `deleteSong`.
- Modify `ui/src/App.tsx` — state + dialog + wire `onDelete`.

---

## Task 1: Backend — `DeleteSong` repo method

**Files:**
- Modify: `backend/internal/library/songs.go`
- Test: `backend/internal/library/songs_delete_test.go`

**Interfaces:**
- Consumes: `Repo` (`type Repo struct{ db *sql.DB }`), test helpers `newRepo(t)` + `mustExec(t,r,sql)` (library test package).
- Produces: `func (r *Repo) DeleteSong(ctx context.Context, id string) (filePath string, existed bool, err error)`.

- [ ] **Step 1: Write the failing test.** Create `backend/internal/library/songs_delete_test.go`:

```go
package library

import (
	"context"
	"testing"
)

func TestDeleteSong_cascadesAndReturnsPath(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO artists(id,name,name_key) VALUES('ar1','A','a')`)
	mustExec(t, r, `INSERT INTO songs(id,title,artist_id,file_path) VALUES('s1','T','ar1','songs/s1.mp3')`)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Rock')`)
	mustExec(t, r, `INSERT INTO song_genres(song_id,genre_id) VALUES('s1','g1')`)
	mustExec(t, r, `INSERT INTO plays(id,song_id) VALUES('p1','s1')`)
	mustExec(t, r, `INSERT INTO playlists(id,name) VALUES('pl1','P')`)
	mustExec(t, r, `INSERT INTO playlist_songs(playlist_id,song_id,position) VALUES('pl1','s1',0)`)

	path, existed, err := r.DeleteSong(ctx, "s1")
	if err != nil || !existed {
		t.Fatalf("delete: existed=%v err=%v", existed, err)
	}
	if path != "songs/s1.mp3" {
		t.Fatalf("path = %q, want songs/s1.mp3", path)
	}
	for _, q := range []string{
		`SELECT count(*) FROM songs WHERE id='s1'`,
		`SELECT count(*) FROM song_genres WHERE song_id='s1'`,
		`SELECT count(*) FROM plays WHERE song_id='s1'`,
		`SELECT count(*) FROM playlist_songs WHERE song_id='s1'`,
	} {
		var n int
		if err := r.db.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if n != 0 {
			t.Fatalf("%q: got %d rows, want 0 (cascade failed)", q, n)
		}
	}
}

func TestDeleteSong_missingReturnsFalse(t *testing.T) {
	r := newRepo(t)
	path, existed, err := r.DeleteSong(context.Background(), "nope")
	if err != nil || existed || path != "" {
		t.Fatalf("got (%q,%v,%v), want (\"\",false,nil)", path, existed, err)
	}
}
```

- [ ] **Step 2: Run to verify it fails.** `cd backend && go test ./internal/library/ -run TestDeleteSong -v` → FAIL (`r.DeleteSong undefined`).

- [ ] **Step 3: Implement.** Add to `backend/internal/library/songs.go` (ensure `database/sql` and `errors` are imported — they are used elsewhere in the file; add if missing):

```go
// DeleteSong removes a song and returns its stored audio file path so the caller
// can delete the file. existed is false when no such song was present. Child rows
// (plays, playlist_songs, song_genres) cascade via FK. Cover art is not touched.
func (r *Repo) DeleteSong(ctx context.Context, id string) (filePath string, existed bool, err error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT file_path FROM songs WHERE id=?`, id).Scan(&filePath)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM songs WHERE id=?`, id); err != nil {
		return "", false, err
	}
	if err = tx.Commit(); err != nil {
		return "", false, err
	}
	return filePath, true, nil
}
```

- [ ] **Step 4: Run to verify it passes.** `cd backend && go test ./internal/library/ -run TestDeleteSong -v` → PASS (2 tests).

- [ ] **Step 5: Commit.**
```bash
git add backend/internal/library/songs.go backend/internal/library/songs_delete_test.go
git commit -m "feat(song): repo DeleteSong (tx, returns audio path, FK cascade)"
```

---

## Task 2: Backend — DELETE handler + route

**Files:**
- Modify: `backend/internal/httpapi/songs.go`
- Modify: `backend/internal/httpapi/server.go`
- Test: `backend/internal/httpapi/songs_delete_test.go`

**Interfaces:**
- Consumes: `songHandlers` (`cfg`, `repo`, `media`), `identify`, `httpError`, `DeleteSong` (Task 1), test helper `uploadFixture(t,h)` (`songs_test.go`), `store.Open`, `New`.
- Produces: `DELETE /api/songs/{id}` → 204 / 404 / 403.

- [ ] **Step 1: Write the failing tests.** Create `backend/internal/httpapi/songs_delete_test.go`:

```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

// deleteTestServer builds a handler over a fresh store and returns the media dir
// so tests can assert on-disk file removal.
func deleteTestServer(t *testing.T, mode config.AuthMode) (http.Handler, string) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: mediaDir, MaxUploadMB: 50}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, st, spa), mediaDir
}

func TestDeleteSong_removesRowAndFile(t *testing.T) {
	h, mediaDir := deleteTestServer(t, config.AuthModeDev)
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr.Code, rr.Body)
	}
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	filePath := filepath.Join(mediaDir, "songs", song.ID+".mp3")
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("expected audio file present: %v", err)
	}

	del := httptest.NewRecorder()
	h.ServeHTTP(del, httptest.NewRequest("DELETE", "/api/songs/"+song.ID, nil))
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete code = %d, want 204 (body %s)", del.Code, del.Body)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("audio file not removed: %v", err)
	}
	get := httptest.NewRecorder()
	h.ServeHTTP(get, httptest.NewRequest("GET", "/api/songs/"+song.ID, nil))
	if get.Code != http.StatusNotFound {
		t.Fatalf("song still present after delete: %d", get.Code)
	}
}

func TestDeleteSong_missingReturns404(t *testing.T) {
	h, _ := deleteTestServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("DELETE", "/api/songs/does-not-exist", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rr.Code)
	}
}

func TestDeleteSong_anonymousForbidden(t *testing.T) {
	h, _ := deleteTestServer(t, config.AuthModeOIDC)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("DELETE", "/api/songs/whatever", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rr.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails.** `cd backend && go test ./internal/httpapi/ -run TestDeleteSong -v` → FAIL (route 404s / handler missing → delete returns 404 not 204, anon path returns 404 not 403).

- [ ] **Step 3: Add the handler.** In `backend/internal/httpapi/songs.go`, add:

```go
// delete removes a song (authed-only): its row (cascading to plays, playlist
// entries, and genre links) and its audio file. Shared cover art is left intact.
func (h *songHandlers) delete(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	filePath, existed, err := h.repo.DeleteSong(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "delete song")
		return
	}
	if !existed {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if filePath != "" {
		_ = h.media.Remove(filePath) // best-effort; missing file is not an error
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 4: Register the route.** In `backend/internal/httpapi/server.go`, immediately after the line `mux.HandleFunc("PATCH /api/songs/{id}", h.patch)`, add:

```go
			mux.HandleFunc("DELETE /api/songs/{id}", h.delete)
```

- [ ] **Step 5: Run to verify it passes.** `cd backend && go test ./internal/httpapi/ -run TestDeleteSong -v` → PASS (3 tests). Then `cd backend && go test ./...` → green.

- [ ] **Step 6: Commit.**
```bash
git add backend/internal/httpapi/songs.go backend/internal/httpapi/server.go backend/internal/httpapi/songs_delete_test.go
git commit -m "feat(song): DELETE /api/songs/{id} (authed, 404 missing, removes audio)"
```

---

## Task 3: Frontend — `player.remove` + pure `removeSong`

**Files:**
- Modify: `ui/src/player.ts`
- Test: `ui/src/player.test.ts`

**Interfaces:**
- Consumes: `PlayerState` (`{ current, queue, history, playing, positionMs, durationMs }`), the module `player` object, `getAudio()`, `emit()`, `state`.
- Produces: `export function removeSong(state: PlayerState, id: string): PlayerState`; `player.remove(id: string): void`.

- [ ] **Step 1: Write the failing test.** Add to `ui/src/player.test.ts` (import `removeSong`):

Change the import to include `removeSong`:
```ts
import { advance, back, qualifiesForPlay, shouldReport, removeSong, type PlayerState } from "./player";
```
Add:
```ts
describe("removeSong", () => {
  it("drops the id from queue and history without touching current", () => {
    const s = removeSong(base({ current: song("a"), queue: [song("b"), song("c")], history: [song("x")] }), "c");
    expect(s.current?.id).toBe("a");
    expect(s.queue.map((q) => q.id)).toEqual(["b"]);
    expect(s.history.map((h) => h.id)).toEqual(["x"]);
  });

  it("clears current and stops when the removed id is the current track", () => {
    const s = removeSong(base({ current: song("a"), queue: [song("b")], playing: true, positionMs: 5000 }), "a");
    expect(s.current).toBeNull();
    expect(s.playing).toBe(false);
    expect(s.positionMs).toBe(0);
    expect(s.queue.map((q) => q.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd ui && npx vitest run src/player.test.ts` → FAIL (`removeSong` not exported).

- [ ] **Step 3: Implement.** In `ui/src/player.ts`, add the pure helper near `advance`/`back`:

```ts
// removeSong drops a song (e.g. one that was deleted) from the player. If it is
// the current track, playback stops and current clears; otherwise it is just
// filtered out of the queue and history.
export function removeSong(state: PlayerState, id: string): PlayerState {
  const queue = state.queue.filter((s) => s.id !== id);
  const history = state.history.filter((s) => s.id !== id);
  if (state.current?.id === id) {
    return { ...state, current: null, queue, history, playing: false, positionMs: 0, durationMs: 0 };
  }
  return { ...state, queue, history };
}
```

Add a `remove` method to the exported `player` object (alongside `next`/`prev`), pausing the audio element when the current track is the one removed:

```ts
  remove(id: string) {
    const wasCurrent = state.current?.id === id;
    state = removeSong(state, id);
    if (wasCurrent) getAudio().pause();
    emit();
  },
```

- [ ] **Step 4: Run to verify it passes.** `cd ui && npx vitest run src/player.test.ts` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add ui/src/player.ts ui/src/player.test.ts
git commit -m "feat(player): remove(id) — stop+clear if current, drop from queue/history"
```

---

## Task 4: Frontend — `ConfirmDialog` component

**Files:**
- Create: `ui/src/ConfirmDialog.tsx`
- Test: `ui/src/ConfirmDialog.test.tsx`

**Interfaces:**
- Produces: `export function ConfirmDialog(props: { title: string; message: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; busy?: boolean; error?: string; onConfirm: () => void; onCancel: () => void })`.

- [ ] **Step 1: Write the failing test.** Create `ui/src/ConfirmDialog.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  const base = { title: "Delete song", message: "Delete “Enter Sandman”?", confirmLabel: "Delete", danger: true, onConfirm: () => {}, onCancel: () => {} };

  it("renders a labeled dialog with title, message and both buttons", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...base} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Delete song");
    expect(html).toContain("Enter Sandman");
    expect(html).toContain("Delete");
    expect(html).toContain("Cancel");
  });

  it("shows the error line and disables confirm while busy", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...base} busy error="Could not delete" />);
    expect(html).toContain("Could not delete");
    expect(html).toContain("disabled");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `cd ui && npx vitest run src/ConfirmDialog.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement.** Create `ui/src/ConfirmDialog.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";

// ConfirmDialog is a reusable modal confirmation, mirroring loom's delete modal
// (hardcoded loom hexes, since the app already mirrors loom's Menu colors and
// uses inline styles rather than Tailwind). Escape or the backdrop cancels; the
// confirm button is focused on mount.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error = "",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [cancelHot, setCancelHot] = useState(false);
  const [confirmHot, setConfirmHot] = useState(false);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", padding: "0 1rem" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, borderRadius: 10, border: "1px solid #55524b", background: "#383834", padding: "1.5rem", boxShadow: "0 24px 60px rgba(0,0,0,0.45)", boxSizing: "border-box" }}
      >
        <h2 style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: 22, fontWeight: 600, color: "#f4f0e8" }}>{title}</h2>
        <div style={{ marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: 1.7, color: "#d5d2c9" }}>{message}</div>
        {error !== "" && <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: "#d98278" }}>{error}</p>}
        <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={onCancel}
            onMouseEnter={() => setCancelHot(true)}
            onMouseLeave={() => setCancelHot(false)}
            style={{ height: 32, borderRadius: 6, border: "none", background: cancelHot ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.10)", padding: "0 0.875rem", fontSize: "0.875rem", fontWeight: 500, color: "#f3f0e8", cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            onMouseEnter={() => setConfirmHot(true)}
            onMouseLeave={() => setConfirmHot(false)}
            style={{
              height: 32,
              borderRadius: 6,
              border: "none",
              background: danger ? (confirmHot ? "#e34948" : "#d03b3b") : "var(--color-accent-strong)",
              padding: "0 0.875rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: danger ? "#fff" : "#1a0f0a",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes.** `cd ui && npx vitest run src/ConfirmDialog.test.tsx` → PASS.

- [ ] **Step 5: Commit.**
```bash
git add ui/src/ConfirmDialog.tsx ui/src/ConfirmDialog.test.tsx
git commit -m "feat(ui): reusable loom-style ConfirmDialog"
```

---

## Task 5: Frontend — `deleteSong` client + wire `App.tsx`

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `ConfirmDialog` (Task 4), `player.remove` (Task 3), existing `setSongs`, `setMenuFor`, `flash`, `player`.
- Produces: `export async function deleteSong(id: string): Promise<void>`.

- [ ] **Step 1: Add the API client.** In `ui/src/api.ts`, mirroring `deletePlaylist`:

```ts
export async function deleteSong(id: string): Promise<void> {
  const r = await fetch(`/api/songs/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`delete failed (${r.status})`);
}
```

- [ ] **Step 2: Wire `App.tsx`.** Add `deleteSong` to the import from `./api` and `ConfirmDialog` import:

```tsx
import { getSession, listSongs, uploadSong, deleteSong, type Session, type Song, type PlaylistDetail } from "./api";
```
```tsx
import { ConfirmDialog } from "./ConfirmDialog";
```

Add state (near the other `useState`s, after `menuFor`):
```tsx
  const [deleteFor, setDeleteFor] = useState<Song | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");
```

Replace the stub `onDelete` in `rowActions`:
```tsx
            onDelete={() => { setMenuFor(null); setDeleteErr(""); setDeleteFor(song); }}
```

Add a delete runner (near `flash`):
```tsx
  const confirmDelete = async () => {
    if (!deleteFor || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteErr("");
    try {
      await deleteSong(deleteFor.id);
      const id = deleteFor.id;
      setSongs((prev) => prev.filter((s) => s.id !== id));
      player.remove(id);
      setDeleteFor(null);
      flash("Song deleted");
    } catch {
      setDeleteErr("Could not delete this song. Please try again.");
    } finally {
      setDeleteBusy(false);
    }
  };
```

Render the dialog (next to the other conditional modals, e.g. after the `editing` TagEditor line):
```tsx
      {deleteFor && (
        <ConfirmDialog
          title="Delete song"
          message={<>Delete “{deleteFor.title}” by {deleteFor.artistName}? This removes it from your library, playlists, and history. This can’t be undone.</>}
          confirmLabel={deleteBusy ? "Deleting…" : "Delete"}
          danger
          busy={deleteBusy}
          error={deleteErr}
          onConfirm={confirmDelete}
          onCancel={() => { if (!deleteBusy) setDeleteFor(null); }}
        />
      )}
```

- [ ] **Step 3: Typecheck + full frontend suite.** `cd ui && npx tsc --noEmit && npx vitest run` → clean + all pass.

- [ ] **Step 4: Commit.**
```bash
git add ui/src/api.ts ui/src/App.tsx
git commit -m "feat(song): wire delete — confirm dialog, list + player/queue cleanup"
```

---

## Task 6: Verify (tests + Playwright) + review + PR

**Files:** none (verification).

- [ ] **Step 1: Full gates.** `cd backend && go test ./... && cd ../ui && npx tsc --noEmit && npx vitest run` → green (ignore the known-flaky HomeFeed test).

- [ ] **Step 2: Build + run the app** with an authenticated dev session (copy the main repo `.env`, override `BACKEND_DB_PATH`/`BACKEND_MEDIA_DIR` to a local gitignored `./data`, `BACKEND_LISTEN_ADDR=:8088`; `cd ui && npm run build` then `go run ./cmd/music`). Upload the sample fixture (or use an existing song) so there's a row to delete.

- [ ] **Step 3: Playwright e2e.**
  - Open the library, open a song's "⋮" menu, click **Delete song** → assert the `role="dialog"` appears naming the song.
  - Click **Cancel** → dialog closes, song still listed.
  - Reopen → **Delete** → assert the row disappears from the list and `GET /api/songs/{id}` returns 404.
  - If the deleted song was playing, assert the player bar clears.

- [ ] **Step 4: Tear down** the dev server; remove local `./data` and the copied `.env`.

- [ ] **Step 5: Read-only code review** over `git diff master..HEAD`; address findings.

- [ ] **Step 6: Open the PR** with `gh` against `trick77/music` `master` (own repo, not a fork). Merge only on explicit go-ahead; remove the worktree after merge.

---

## Self-Review (completed by plan author)

- **Spec coverage:** endpoint + authed/404/204 (Task 2), cascade + audio removal + cover-art untouched (Tasks 1–2), ConfirmDialog mirroring loom (Task 4), wiring + list update (Task 5), stop-player-if-current + drop-from-queue (Tasks 3 + 5), tests + e2e (Tasks 1–6). All spec sections map to a task.
- **Placeholders:** none — every code step is complete.
- **Type consistency:** `DeleteSong(ctx,id) (string,bool,error)`, the `delete` handler, `removeSong`/`player.remove`, `ConfirmDialog` props, and `deleteSong(id)` are used identically across tasks.
