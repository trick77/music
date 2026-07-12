# Playlists Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give playlists a first-class dedicated Playlists page, no-modal in-place editing, and two AI features (guided cover art + tone-varied description), reusing existing image/LLM plumbing.

**Architecture:** Backend adds playlist-scoped AI endpoints modeled on the existing album-cover flow (`suggest-prompt` → `refine-prompt` → generate via `POST /api/studio/coverart` → apply cover-from-id) plus a new tone-variant description writer over `llm.Client.Chat`; a description-only PATCH relaxes the existing update. Frontend promotes Playlists to a rail destination with a dedicated list page and rebuilds the single-playlist view with an on-page (no-modal) edit mode; the old `PlaylistEditor` modal is retired.

**Tech Stack:** Go 1.x (net/http `ServeMux`, `database/sql`/SQLite), React 19 + TypeScript + Vite 8, Vitest, Playwright.

## Global Constraints

- No new modals for editing — iPad truncates modal bottoms. Editing is on-page/in-place. Any unavoidable overlay must be `max-height:100dvh` + `overflow-y:auto` + `env(safe-area-inset-bottom)` padding.
- Do NOT push to `master`; work stays on branch `worktree-playlists-redesign`, PR at the end.
- German/UI copy uses Swiss orthography (`ss`, never `ß`) — not expected here, but honor it in any generated copy prompts.
- AI endpoints are gated: cover art on `cfg.ImageGenEnabled()` (BFL key) + `imageGen != nil`; text on `cfg.ChatEnabled()` + a non-nil prompter. Absent config → the endpoint 404s and the UI control is hidden (presence-vs-absence, matching studio/fanart).
- Backend endpoints must be tested through the real server/mux (routes + auth + gating), not just in-package units.
- Playlists queue the WHOLE list when played (Play = in order, Shuffle = randomized) — never a single song.
- Reuse before adding: `SetPlaylistCover`, `CreateCover`/`FindCoverByHash`, `GetStudioCoverArt`, `GenrePrompter.RefinePrompt`, `player.play(song, tail)` already exist.

---

## Phase 1 — Backend: AI description writer (tone variants)

### Task 1: `DescriptionWriter` — three-tone playlist descriptions from song context

**Files:**
- Create: `backend/internal/studio/description.go`
- Modify: `backend/internal/studio/prompts.go` (add system + user prompt builders)
- Test: `backend/internal/studio/description_test.go`

**Interfaces:**
- Consumes: `llm.Chat` (existing: `Chat(ctx, []llm.Message, []llm.Tool) (llm.Message, error)`); `extractJSONObject` (existing in package `studio`).
- Produces:
  ```go
  type PlaylistTones struct { Punchy, Evocative, Factual string }
  type DescriptionWriter interface {
      PlaylistDescriptions(ctx context.Context, name string, songs []library.PlaylistTrackBrief) (PlaylistTones, error)
  }
  func NewDescriptionWriter(chat llm.Chat) DescriptionWriter
  type // library.PlaylistTrackBrief{ Title, Artist string; Genres []string } (defined in Task 2 — land that first)
  ```
> **Ordering:** Task 2 defines `library.PlaylistTrackBrief`. Do Task 2 before Task 1, or add a throwaway stub struct to compile Task 1's test.

- [ ] **Step 1: Write the failing test** (fake `llm.Chat` returning canned JSON; assert the three tones parse)

```go
package studio

import (
	"context"
	"testing"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

type fakeChat struct{ reply string }
func (f fakeChat) Chat(_ context.Context, _ []llm.Message, _ []llm.Tool) (llm.Message, error) {
	return llm.Message{Role: "assistant", Content: f.reply}, nil
}

func TestPlaylistDescriptions_parsesThreeTones(t *testing.T) {
	json := `{"punchy":"Windows down.","evocative":"Sun-bleached highway pop.","factual":"12 synthwave songs."}`
	w := NewDescriptionWriter(fakeChat{reply: json})
	got, err := w.PlaylistDescriptions(context.Background(), "Road Trip", []library.PlaylistTrackBrief{
		{Title: "Nightcall", Artist: "Kavinsky", Genres: []string{"synthwave"}},
	})
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if got.Punchy == "" || got.Evocative == "" || got.Factual == "" {
		t.Fatalf("empty tone in %+v", got)
	}
	if got.Evocative != "Sun-bleached highway pop." { t.Fatalf("got %q", got.Evocative) }
}

func TestPlaylistDescriptions_errorsOnEmptyTone(t *testing.T) {
	w := NewDescriptionWriter(fakeChat{reply: `{"punchy":"x","evocative":"","factual":"y"}`})
	if _, err := w.PlaylistDescriptions(context.Background(), "P", nil); err == nil {
		t.Fatal("expected error on empty tone")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/studio/ -run TestPlaylistDescriptions -v`
Expected: FAIL (build error — `NewDescriptionWriter`/`PlaylistTrackBrief` undefined). Add a temporary `PlaylistTrackBrief` stub in `library` if needed to compile, then remove when Task 3 lands it for real.

- [ ] **Step 3: Add prompt builders** in `prompts.go`

```go
const playlistDescSystemPrompt = `You are a music editor writing short playlist descriptions.
Given a playlist name and its songs, write THREE one-sentence descriptions in distinct tones.
Return ONLY JSON: {"punchy":"...","evocative":"...","factual":"..."}.
- punchy: energetic, imperative, <= 12 words.
- evocative: mood and imagery, <= 22 words.
- factual: plain summary of count/genres/energy, <= 22 words.
No emojis. No quotes inside values.`

func playlistDescUserPrompt(name string, songs []library.PlaylistTrackBrief) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Playlist: %s\nSongs:\n", name)
	for i, s := range songs {
		if i >= 40 { break } // cap prompt size
		g := strings.Join(s.Genres, ", ")
		fmt.Fprintf(&b, "- %s — %s (%s)\n", s.Title, s.Artist, g)
	}
	return b.String()
}
```

- [ ] **Step 4: Implement `description.go`**

```go
package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

type PlaylistTones struct {
	Punchy    string `json:"punchy"`
	Evocative string `json:"evocative"`
	Factual   string `json:"factual"`
}

type DescriptionWriter interface {
	PlaylistDescriptions(ctx context.Context, name string, songs []library.PlaylistTrackBrief) (PlaylistTones, error)
}

type descriptionWriter struct{ chat llm.Chat }

func NewDescriptionWriter(chat llm.Chat) DescriptionWriter { return &descriptionWriter{chat: chat} }

func (d *descriptionWriter) PlaylistDescriptions(ctx context.Context, name string, songs []library.PlaylistTrackBrief) (PlaylistTones, error) {
	msgs := []llm.Message{
		{Role: "system", Content: playlistDescSystemPrompt},
		{Role: "user", Content: playlistDescUserPrompt(name, songs)},
	}
	reply, err := d.chat.Chat(ctx, msgs, nil)
	if err != nil {
		return PlaylistTones{}, err
	}
	obj, err := extractJSONObject(reply.Content)
	if err != nil {
		return PlaylistTones{}, err
	}
	var t PlaylistTones
	if err := json.Unmarshal([]byte(obj), &t); err != nil {
		return PlaylistTones{}, fmt.Errorf("studio: parse playlist descriptions: %w", err)
	}
	t.Punchy, t.Evocative, t.Factual = strings.TrimSpace(t.Punchy), strings.TrimSpace(t.Evocative), strings.TrimSpace(t.Factual)
	if t.Punchy == "" || t.Evocative == "" || t.Factual == "" {
		return PlaylistTones{}, fmt.Errorf("studio: a playlist tone came back empty")
	}
	return t, nil
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test ./internal/studio/ -run TestPlaylistDescriptions -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/internal/studio/description.go backend/internal/studio/prompts.go backend/internal/studio/description_test.go
git commit -m "feat(studio): three-tone playlist description writer"
```

---

## Phase 2 — Backend: playlist song context + description/prompt/cover endpoints

### Task 2: `PlaylistTrackBrief` + `PlaylistContext` repo helper

**Files:**
- Modify: `backend/internal/library/playlists.go`
- Test: `backend/internal/library/playlists_test.go`

**Interfaces:**
- Produces:
  ```go
  type PlaylistTrackBrief struct { Title, Artist string; Genres []string }
  // Repo method: brief song rows for a playlist (for grounding AI prompts).
  func (r *Repo) PlaylistContext(ctx context.Context, playlistID string) (name string, songs []PlaylistTrackBrief, err error)
  ```

- [ ] **Step 1: Write failing test** — seed a playlist with 2 songs (reuse existing test helpers/fixtures in `playlists_test.go`), assert `PlaylistContext` returns the name and 2 briefs with artist/genres populated.
- [ ] **Step 2: Run** `cd backend && go test ./internal/library/ -run TestPlaylistContext -v` → FAIL (undefined).
- [ ] **Step 3: Implement** `PlaylistTrackBrief` + `PlaylistContext` (join `playlists`→`playlist_songs`→`songs`, and the genres per song exactly as `playlistSongs` already does at `playlists.go:131`; order by `ps.position`). Reuse the genre-loading pattern already in that file.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(library): PlaylistContext for AI grounding`.

### Task 3: Description-only PATCH (fix name-resend)

**Files:**
- Modify: `backend/internal/httpapi/playlists.go:98-117` (`patch`), `backend/internal/library/playlists.go` (`UpdatePlaylist`)
- Test: `backend/internal/httpapi/playlists_http_test.go`

**Interfaces:**
- Produces: `PATCH /api/playlists/{id}` accepts `{name?, description?}`; when `name` omitted, keeps the existing name and updates description only.

- [ ] **Step 1: Failing HTTP test** through the real mux (see Task 6 harness): create a playlist, `PATCH` with `{"description":"new"}` only, assert 200 and that GET shows the new description with the original name intact.
- [ ] **Step 2: Run** → FAIL (current handler 400s on empty name).
- [ ] **Step 3: Implement** — make `playlistBody` fields pointers or add an `UpdatePlaylistDescription`/partial update path: if `body.Name == ""`, call a repo update that sets description only; else current behavior. Keep create's name-required check.
- [ ] **Step 4: Run** → PASS. Also run existing playlist tests to ensure no regression.
- [ ] **Step 5: Commit** `fix(playlists): allow description-only PATCH`.

### Task 4: Playlist AI endpoints (suggest-prompt, refine-prompt, cover-from-id, suggest-description)

**Files:**
- Modify: `backend/internal/httpapi/playlists.go` (new handlers + struct deps), `backend/internal/httpapi/server.go:188-199` (deps + routes)
- Create: `backend/internal/httpapi/playlists_ai.go` (keep the AI handlers separate from CRUD)
- Test: `backend/internal/httpapi/playlists_ai_test.go`

**Interfaces:**
- Consumes: `studio.GenrePrompter` (`AlbumCoverPrompt`, `RefinePrompt`), `studio.DescriptionWriter` (Task 1), `imagegen.Provider`, `Repo.PlaylistContext` (Task 2), and the album-cover promotion pattern (`album_cover.go:114-161`).
- Produces routes:
  - `POST /api/playlists/{id}/suggest-prompt` → `{prompt}` (square cover prompt grounded in playlist songs; reuse `AlbumCoverPrompt` by passing playlist name as "album", joined genres, and per-song lyric excerpts if cheaply available — else pass empty lyrics).
  - `POST /api/playlists/{id}/refine-prompt` body `{current, instruction}` → `{prompt}` (reuse `RefinePrompt`, context = playlist name).
  - `POST /api/playlists/{id}/cover` body `{studioCoverArtId}` → `{coverArtId}` (promote generated PNG → `CreateCover` (dedup) → `SetPlaylistCover`; copy `postAlbumCover` verbatim, swapping the target for the playlist and 404ing on unknown playlist).
  - `POST /api/playlists/{id}/suggest-description` → `{punchy, evocative, factual}` (via DescriptionWriter + PlaylistContext; 400 if playlist empty).

**Struct change:** extend `playlistHandlers` with `genrePrompter studio.GenrePrompter`, `descriptions studio.DescriptionWriter`, `imageGen imagegen.Provider`; construct in `server.go` from the same values `songHandlers` uses (they are in scope where `pl := &playlistHandlers{...}` is built).

- [ ] **Step 1: Failing test** — `playlists_ai_test.go` builds the server with a fake `GenrePrompter`/`DescriptionWriter` and a fake `imagegen.Provider`; for each new route assert: 403 when unauthenticated, 404 when the relevant config is nil, and the happy-path JSON shape when wired. For cover-from-id, seed a `studio_coverart` "ready" row and assert the response `coverArtId` and that `GetPlaylist` now has it.
- [ ] **Step 2: Run** `cd backend && go test ./internal/httpapi/ -run TestPlaylistAI -v` → FAIL.
- [ ] **Step 3: Implement** the four handlers in `playlists_ai.go` (mirror `postAlbumSuggestPrompt`, `postAlbumCover`, `postStudioCoverArt` gating exactly) and register routes in `server.go`. Reuse `readMediaBytes`, `writeBytes`, `FindCoverByHash`, `CreateCover`, `SetPlaylistCover`.
- [ ] **Step 4: Run** → PASS; then `cd backend && go test ./...` → all green.
- [ ] **Step 5: Commit** `feat(playlists): AI cover prompt/refine/apply + description endpoints`.

> Cover *generation* itself reuses the existing `POST /api/studio/coverart` (prompt → studioCoverArtId). No new generation endpoint needed.

---

## Phase 3 — Frontend: API client + shuffle + nav

### Task 5: API client additions

**Files:** Modify `ui/src/api.ts` (playlist block ~133-224)
**Interfaces — Produces:**
```ts
export function suggestPlaylistPrompt(id: string): Promise<{ prompt: string }>;
export function refinePlaylistPrompt(id: string, current: string, instruction: string): Promise<{ prompt: string }>;
export function applyPlaylistCover(id: string, studioCoverArtId: string): Promise<PlaylistDetail>;
export function suggestPlaylistDescriptions(id: string): Promise<{ punchy: string; evocative: string; factual: string }>;
export function updatePlaylistDescription(id: string, description: string): Promise<PlaylistDetail>; // PATCH {description}
// reuse existing generateStudioCoverArt(prompt) if present; else add postJSON('/api/studio/coverart',{prompt}).
```
- [ ] Steps: add typed fetch wrappers following the existing `createPlaylist`/`updatePlaylist` style; `cd ui && npx tsc --noEmit` clean; commit `feat(ui): playlist AI api client`.

### Task 6: `shuffle()` helper + Shuffle/Play-all wiring

**Files:** Modify `ui/src/player.ts`; Test `ui/src/player.test.tsx`
**Interfaces — Produces:** `export function shuffle<T>(items: T[]): T[]` (pure, Fisher–Yates; does not mutate input).

- [ ] **Step 1: Failing test**
```ts
import { shuffle } from "./player";
it("returns a permutation without mutating input", () => {
  const src = [1,2,3,4,5];
  const out = shuffle(src);
  expect(out.slice().sort()).toEqual([1,2,3,4,5]);
  expect(src).toEqual([1,2,3,4,5]); // unchanged
});
```
- [ ] **Step 2: Run** `cd ui && npx vitest run src/player.test.tsx` → FAIL.
- [ ] **Step 3: Implement** Fisher–Yates copy. (Play-all uses existing `player.play(first, rest)`; Shuffle uses `player.play(sh[0], sh.slice(1))` where `sh = shuffle(songs)`.)
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(player): pure shuffle helper`.

### Task 7: Playlists rail destination + route

**Files:** Modify `ui/src/Glyph.tsx` (add `playlist` glyph, e.g. lucide `ListMusic`→ rename current queue import or use `ListVideo` for playlists so it stays distinct from `queue`), `ui/src/Rail.tsx` (ITEMS + tab bar), `ui/src/router.ts` (ensure `/playlists` route + `playlists` route name exists — it does), `ui/src/App.tsx` (route `playlists` → new `PlaylistsPage`, stop routing it into `Library`), `ui/src/Library.tsx` (remove the Playlists tab).
**Interfaces — Consumes:** `navigate`, `Glyph`. **Produces:** rail shows Playlists; `/playlists` renders `PlaylistsPage` (Task 8).

- [ ] Steps: add glyph; add `{ key:"playlists", icon:"playlist", label:"Playlists", path:"/playlists", match:(r)=>r.name==="playlists" }` to `ITEMS` (after `library`); drop `playlists` from `Library`'s `initialTab` handling and its Tab list; point `App.tsx` `route.name==="playlists"` at `<PlaylistsPage .../>`.
- [ ] Verify: `cd ui && npm run build` clean. Playwright check deferred to Task 11.
- [ ] Commit `feat(ui): Playlists rail icon + dedicated route`.

---

## Phase 4 — Frontend: dedicated Playlists page & single-playlist page

### Task 8: `PlaylistsPage` (list rows)

**Files:** Create `ui/src/PlaylistsPage.tsx`; Test `ui/src/PlaylistsPage.test.tsx`
**Interfaces — Consumes:** `listPlaylists()`, `createPlaylist(name)`, `coverUrl`, `navigate`, `onPlay(song, tail)`. **Produces:** default-exported `PlaylistsPage` component.

Behavior (mirror `docs/mockups/playlists/redesign.html` Decision 1B):
- Header "Playlists" + count + "+ New playlist" (creates `createPlaylist("New playlist")` then `navigate('/playlist/'+id+'?edit=1')`).
- Rows: cover thumb (`coverUrl(coverArtId,'thumb')` or note placeholder), name, `${count} songs`, "Unpublished" badge, quick ▶ that loads the playlist detail and calls `onPlay(songs[0], songs.slice(1))`. Row body → `navigate('/playlist/'+id)`.

- [ ] **Step 1: Failing Vitest** — `renderToStaticMarkup(<PlaylistsPage .../>)` (stub `listPlaylists`) contains "Playlists" and a row name. **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: PASS.** **Step 5: Commit** `feat(ui): dedicated PlaylistsPage list`.

### Task 9: Single-playlist page — header (2B) + play/shuffle + publish/share

**Files:** Modify `ui/src/Detail.tsx` playlist branch (or extract `ui/src/PlaylistPage.tsx` if the playlist branch grows unwieldy — prefer extraction). Test: `ui/src/PlaylistPage.test.tsx`.
**Interfaces — Consumes:** `getPlaylist`, `togglePlaylistPublish`(existing), `shareUrl`, `onPlay`, `shuffle`. 

Behavior: square cover + meta header (name, description, `${count} songs`), actions **Play** (`onPlay(songs[0], songs.slice(1))`), **Shuffle** (`const s=shuffle(songs); onPlay(s[0], s.slice(1))`), **Add songs**, **Edit** (authed → enters edit mode, Task 10), Publish/Unpublish, Share, and an **Edit** entry honoring `?edit=1`.

- [ ] Steps: TDD the static header render (name + description + counts + Play button present). Build; commit `feat(ui): playlist page header with play/shuffle`.

### Task 10: In-place edit mode (no modal) — name, description, reorder, add/remove, delete

**Files:** Modify `ui/src/PlaylistPage.tsx`; retire `ui/src/PlaylistEditor.tsx` (delete file + remove mount in `App.tsx`); keep `ui/src/AddToPlaylist.tsx` but replace its `window.prompt` create path with a proper inline create (small on-page input, not a modal). Test: `ui/src/PlaylistPage.test.tsx`.
**Interfaces — Consumes:** `updatePlaylist`, `updatePlaylistDescription`, `addSongToPlaylist`, `removeSongFromPlaylist`, `reorderPlaylist`, `deletePlaylist`, `listSongs`.

Behavior: an "Edit" toggle reveals: editable name (blur → `updatePlaylist`), editable description (blur → `updatePlaylistDescription`), drag-handle reorder (reuse the HTML5 DnD logic from the old `PlaylistEditor`), per-row remove, an "Add songs" typeahead (reuse old editor's client-side filter over `listSongs`), and a **Delete playlist** button with an inline confirm (two-step button, no modal) → `deletePlaylist` then `navigate('/playlists')`.

- [ ] Steps: TDD render of edit-mode controls (delete button + add-songs field present when `editing`); port DnD + typeahead from old editor; wire delete-with-confirm; remove `PlaylistEditor` import/mount from `App.tsx`. Build clean. Commit `feat(ui): in-place playlist editing, retire editor modal`.

### Task 11: AI cover panel (3A) + AI description chips (Decision 4)

**Files:** Modify `ui/src/PlaylistPage.tsx` (edit-mode surface). Reuse whatever album-cover panel component exists in `StudioPage.tsx`/`StudioShared.tsx` if one is factored; otherwise build a small `PlaylistCoverPanel` inline.
**Interfaces — Consumes:** `suggestPlaylistPrompt`, `refinePlaylistPrompt`, generate via studio cover-art, `applyPlaylistCover`, `suggestPlaylistDescriptions`, `updatePlaylistDescription`.

Behavior:
- **Cover:** editable prompt box; "Suggest from songs" → `suggestPlaylistPrompt`; "Generate" → studio coverart (prompt → `studioCoverArtId`, preview via `GET /api/studio/coverart/{id}`); "Apply" → `applyPlaylistCover` → refresh detail. Hidden when image gen not configured.
- **Description:** "Suggest descriptions" → `suggestPlaylistDescriptions` → render 3 tone chips (Punchy/Evocative/Factual), **Evocative pre-selected**; clicking a chip fills the (editable) description field; save via description PATCH. Hidden when chat not configured.

- [ ] Steps: TDD the chip default-selection logic (a pure helper `defaultTone(tones)=>tones.evocative`); wire the flows; guard on config flags from `session`. Build clean. Commit `feat(ui): AI cover panel + description tones on playlist page`.

---

## Phase 5 — Verify & finish

### Task 12: End-to-end browser verification (no modals) + full suites

- [ ] `cd backend && go test ./...` → green.
- [ ] `cd ui && npm run build && npx vitest run` → green.
- [ ] Launch the app (see project run patterns), then via Playwright with an authed session and image/chat configured (or stub): rail Playlists icon → `/playlists`; create → opens in edit mode; add songs; reorder via handles; Suggest→Generate→Apply a cover; Suggest descriptions → pick a tone; Play and Shuffle both queue >1 song; Delete with confirm returns to `/playlists`. Confirm at a 820px-wide (tablet) viewport that **no edit surface is truncated** and there is no modal.
- [ ] Screenshot the playlist page (edit mode + AI panels) and confirm visually.
- [ ] Commit any fixes; open PR `feat: playlists redesign` targeting `master` (the user's own repo — not a fork).

## Self-review coverage map
- Spec §Nav → Task 7, 8. §Playlist page 2B/5B → Task 9, 10. §AI cover 3A → Task 4, 11. §AI description → Task 1, 4, 11. §Always-on (delete/create/desc-PATCH/reorder/shuffle) → Tasks 3, 6, 8, 10. §Publish/Share → Task 9. §Mobile tab → Task 7. §Verification → Task 12.
