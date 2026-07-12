# Playlists Redesign — Design Spec

_Date: 2026-07-12_

## Context

Playlists exist today but feel underrepresented. The backend CRUD is actually fairly
complete (create, rename, edit description, delete, add/remove song, reorder,
publish/unpublish, cover upload), but the experience around it is thin and has real
gaps:

- Playlists are buried as a **sub-tab inside Library**; they have no first-class presence.
- **Delete has an API but no UI** — you cannot delete a playlist from the app today.
- Covers are **manual upload only** — no AI generation, no identity.
- There is **no description generation** anywhere in the codebase.
- Paper-cuts: "New playlist" uses a raw `window.prompt`; editing the description forces
  you to resend the name; management is spread across a modal + popups.
- Modals get **truncated at the bottom on iPad** (observed on the tag-edit modal), so the
  redesign deliberately avoids modals for editing.

Goal: give playlists a first-class home, complete and streamline management (no modals),
and add two AI features — **guided cover-art generation** and **tone-varied description
generation** — reusing the app's existing image + LLM plumbing.

## Decisions (from the mockup option board, `docs/mockups/playlists/redesign.html`)

- **1B — Dedicated rail destination.** A new **Playlists** icon in the left rail opens a
  dedicated Playlists page (list rows: cover thumb + name + count + quick ▶). Rows are
  navigational only. Playlists move **out of the Library tabs**. **Nothing on the Home
  startpage.** On mobile, Playlists gets its own bottom tab-bar slot.
- **2B — Playlist page header** = square cover + metadata side-by-side (name, AI
  description, counts, Play/Shuffle/Add/Edit actions).
- **3A — Inline AI cover panel.** Guided prompt flow (album-style: suggest → refine →
  generate → apply) living **in the in-place edit surface** of the playlist page — not a
  modal.
- **4 — AI description**, default tone **Evocative** (all three tones — Punchy / Evocative
  / Factual — are generated each time; the default is pre-selected; the result is editable).
- **5B — In-place editing.** Rename, description, reorder, add/remove songs, cover, delete,
  publish/share all happen **on the playlist page** via an "Edit" toggle. **No modals.**
- **Keep Publish + Share** (existing behavior: published playlists are visible to anon).
- **Always-on fixes:** wired **Delete** (with confirm), proper create flow (no
  `window.prompt`), edit description without resending name, drag-handle reorder, and
  **Shuffle + Play all** on every playlist.

## Architecture & components

### Navigation (`ui/src/Rail.tsx`, `ui/src/router.ts`, `ui/src/Glyph.tsx`)
- Add a `playlist`-style glyph (lucide, e.g. `ListMusic`/`ListVideo` — distinct from the
  `queue` glyph) to `Glyph.tsx`.
- Add a **Playlists** rail item (desktop rail + mobile tab bar) routing to `/playlists`.
- `/playlists` now renders a new **PlaylistsPage** (not the Library tab). Remove the
  Playlists tab from `Library.tsx` (favorites/genres/albums/artists/songs remain).

### PlaylistsPage (new, `ui/src/PlaylistsPage.tsx`)
- Header: "Playlists", count, "+ New playlist".
- List rows via `listPlaylists()`: cover thumb, name, song count + short descriptor,
  quick ▶ (plays the playlist — `onPlay(firstSong, rest)` so it queues the whole list),
  "Unpublished" badge where relevant. Tap row → `/playlist/{id}`.
- "+ New playlist": creates an empty playlist server-side and navigates to its page in
  edit mode (no `window.prompt`).

### Playlist page (`ui/src/Detail.tsx` playlist branch, or a dedicated `PlaylistPage.tsx`)
- **Header (2B):** square cover (`coverUrl`), name, AI description, counts, and actions:
  **Play**, **Shuffle**, **Add songs**, **Edit** (authed), Publish/Unpublish, Share, ⋯.
- **In-place edit mode (5B):** an "Edit" toggle reveals inline editing — editable name &
  description, drag-handle reorder, per-row remove, an "Add songs" search, the **AI cover
  panel (3A)**, an **AI description** control, and a **Delete playlist** button (with a
  confirm). No modal; everything renders on the page. **Retire `PlaylistEditor.tsx`**
  (the editing modal). **Keep `AddToPlaylist.tsx`** — the "Add to playlist…" song-menu
  action (adding a song from Library/Search/anywhere) is still needed; only replace its
  `window.prompt` "New playlist" path with the proper create flow.
- **Play/Shuffle** feed the player: Play queues the whole list in order; Shuffle queues a
  randomized order. (Shuffle is the small bonus that motivated this.)

### Shuffle (`ui/src/player.ts`)
- Add a pure `shuffle(songs)` helper (unit-tested) and wire a Shuffle action that calls
  `player.play(first, restShuffled)`. No global shuffle-mode state required for v1.

### AI cover generation (backend + frontend)
- **Reuse the album flow** as the template: `POST /api/albums/suggest-prompt`,
  `.../refine-prompt`, studio cover-art generation, and `POST /api/albums/cover`
  (promote a generated `studio_coverart` id into `cover_art` + attach).
- Add the playlist equivalents:
  - `POST /api/playlists/{id}/suggest-prompt` → author a square cover prompt grounded in
    the playlist's songs (artists, genres, moods), via `studio.GenrePrompter`-style
    one-shot LLM call (new method alongside `AlbumCoverPrompt`).
  - `POST /api/playlists/{id}/refine-prompt` → reuse `RefinePrompt`.
  - `POST /api/playlists/{id}/cover` (JSON, cover-art id) → read `studio_coverart`,
    `CreateCover` (dedup by hash), `SetPlaylistCover` (already exists in the repo — just
    needs this endpoint). Keep the existing multipart `PUT .../cover` for manual upload.
- Generation is disabled when the playlist is empty (nothing to ground the prompt).

### AI description generation (backend + frontend)
- New backend endpoint `POST /api/playlists/{id}/suggest-description` returning **three
  tone variants** `{punchy, evocative, factual}`, generated from the playlist's songs
  (titles/artists/genres/moods) via `llm.Client.Chat` (new one-shot method; no web
  research). Frontend shows the three as selectable chips (default: **Evocative**), fills
  the editable description field on pick. Saving uses the description PATCH.

### Backend management fixes (`backend/internal/httpapi/playlists.go`, `library/playlists.go`)
- Allow **description-only** updates (don't force `name` to be resent) — relax the PATCH
  validation or accept partial fields.
- Everything else (create/delete/add/remove/reorder/publish) already exists and is reused.

## Data model
- No schema change strictly required. Consider adding `updated_at` to `playlists` (nice for
  sorting "recently edited") — optional, decide during planning. No `owner` column (app has
  a single shared session; keep current auth model).

## Out of scope (v1)
- Auto-regenerating covers/descriptions on song changes (explicitly rejected — one-click,
  editable).
- Per-user ownership / multi-user playlists.
- Collaborative playlists, smart/auto playlists, folders.
- Home-startpage playlist presence (explicitly excluded).

## Verification
- **Backend:** unit tests for the new library methods (suggest-description tone shape,
  playlist cover-from-id promotion) and **HTTP-path tests through the real server/mux**
  for every new endpoint (routes, auth gating, empty-playlist guard) — not just in-package
  units. `go test ./...` green.
- **Frontend:** `cd ui && npm run build` (tsc + vite) + Vitest green, including a
  `shuffle()` unit test and PlaylistsPage rendering.
- **End-to-end in a real browser (Playwright), no modals:** create a playlist → it opens
  in edit mode → add songs → reorder via drag handles → generate a cover (guided prompt)
  and apply → generate descriptions and pick a tone → Play and Shuffle queue correctly →
  Delete with confirm removes it. Verify the Playlists rail icon/route and that the page
  is reachable and **not truncated on a narrow/tablet viewport**.
- AI endpoints require `ChatEnabled()` / `ImageGenEnabled()`; verify graceful
  absence-of-key behavior (controls hidden/disabled), mirroring existing studio/fanart
  presence-vs-absence.

## Key files
- New: `ui/src/PlaylistsPage.tsx`; spec doc + `docs/mockups/playlists/redesign.html`.
- Modify: `ui/src/Rail.tsx`, `ui/src/Glyph.tsx`, `ui/src/router.ts`, `ui/src/Library.tsx`,
  `ui/src/Detail.tsx` (playlist branch) or new `PlaylistPage.tsx`, `ui/src/player.ts`,
  `ui/src/api.ts`; retire `ui/src/PlaylistEditor.tsx`.
- Backend: `backend/internal/httpapi/playlists.go` + `server.go` (new routes),
  `backend/internal/library/playlists.go`, and studio/LLM helpers alongside
  `backend/internal/studio/genreprompt.go` / `prompts.go`.
