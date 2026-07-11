# Song delete — Design

## Context

The library UI already exposes a **"Delete song"** action in the per-song context menu
(`ui/src/SongMenu.tsx` — trash icon, `danger` styling, gated on `authenticated`), but its
`onDelete` handler is a stub: `App.tsx` currently does
`onDelete={() => { setMenuFor(null); flash("Delete is coming in a later phase"); }}`. There is no
backend delete endpoint and no confirmation UI. This phase makes the button actually delete a song
— behind a `../loom`-style confirmation dialog — and updates the player/library state afterward.

The need: users can upload, edit, and cover songs but cannot remove one. Deletion is destructive,
so it must be confirmed and must clean up cleanly (row + cascades + audio file) without harming
shared album cover art.

## Goals / Non-goals

**Goals**
- `DELETE /api/songs/{id}` — authed-only; removes the song row (FK-cascading to `plays`,
  `playlist_songs`, `song_genres`) and its per-song audio file; `404` when the song is absent.
- A reusable **`ConfirmDialog`** in the music app, mirroring `../loom`'s `DeleteProjectModal`.
- Wire the existing menu item: confirm (naming the song) → delete → remove from the library list,
  close the menu.
- If the deleted song is the one currently playing, **stop playback and clear the player bar**, and
  drop it from the in-memory queue.

**Non-goals**
- No cover-art garbage collection. Covers are shared across an album and content-hash-deduped, with
  no ref-counting in the codebase; deleting a song leaves `cover_art` rows/files untouched.
- No bulk delete, no undo/trash, no soft-delete.
- No change to anonymous behavior — the menu item is already authed-only; the endpoint returns 403
  for anonymous callers.

## Decisions (settled with owner)

| Decision | Choice |
|---|---|
| Destructive scope | Row + FK cascades (`plays`/`playlist_songs`/`song_genres`) + the per-song audio file. Cover art untouched. |
| Currently-playing song | Stop playback + clear the player bar if it's the current song; drop it from the queue. |
| Confirmation | A `../loom`-style modal dialog (not `window.confirm`). |
| Missing song | `404` (an improvement over the playlist delete, which always `204`s). |

## Architecture

Three small units:

1. **Repo delete** — `library.Repo.DeleteSong(ctx, id) (string, error)` returns the deleted song's
   audio `file_path` (so the handler can remove the file) and whether a row existed. A single
   `DELETE FROM songs WHERE id=?` cascades to the three child tables (FK enforcement is ON:
   `store.go` opens sqlite with `_pragma=foreign_keys(1)`).

2. **HTTP handler** — `songHandlers.delete` on `DELETE /api/songs/{id}`. `songHandlers` already
   holds `repo` + `media`. Authed-gate (403), 404 when absent, else delete row → best-effort
   `media.Remove(filePath)` → `204 No Content`.

3. **Frontend** — a new `ConfirmDialog` component + `deleteSong(id)` API client, wired into the
   existing `onDelete` call site in `App.tsx`, with post-delete list/player/queue updates.

### Backend data flow

```
DELETE /api/songs/{id}
  ├─ identify(cfg,r).Authenticated? else 403
  ├─ DeleteSong(id): SELECT file_path → if none, (","", false) → 404
  │     else DELETE FROM songs WHERE id=?  (cascades plays/playlist_songs/song_genres)
  │     return (file_path, true)
  ├─ media.Remove(file_path)   (best-effort; missing file = success)
  └─ 204 No Content
```

`DeleteSong` reads `file_path` and deletes in one transaction so the returned path always matches
the row that was removed. The audio file (`songs/{id}.mp3`) is unique per song → safe to remove.
`cover_art` is never referenced by the delete (the `songs.cover_art_id` FK is `ON DELETE SET NULL`,
irrelevant here since the row itself is gone).

### Frontend flow

```
SongMenu "Delete song" → onDelete(song)
  → App opens <ConfirmDialog> (song title in the message)
      Cancel → close
      Delete → deleteSong(id)
        success → setSongs(filter out id); if playing===id → stop player + clear bar;
                  drop id from queue; close dialog + menu
        failure → show error line in the dialog, keep it open
```

### ConfirmDialog component

Reusable, prop-driven, mirroring loom's `DeleteProjectModal` translated to the music app's inline-
style convention (the app uses inline `React.CSSProperties`, not Tailwind; it already hardcodes
loom's menu hexes in `Menu.tsx`, so we match loom's dialog hexes the same way):

- Props: `{ title, message, confirmLabel, cancelLabel?, danger?, busy?, error?, onConfirm, onCancel }`.
- Overlay: `position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
  background: rgba(0,0,0,0.5); backdrop-filter: blur(2px); padding: 0 1rem`.
- Panel (`role="dialog"`, `aria-label={title}`): `max-width: 460px; border-radius: 10px;
  border: 1px solid #55524b; background: #383834; padding: 1.5rem;
  box-shadow: 0 24px 60px rgba(0,0,0,0.45)`.
- Title 22px semibold `#f4f0e8`; body 14px/1.7 `#d5d2c9`; error line `#d98278`.
- Buttons right-aligned: Cancel (translucent white `rgba(255,255,255,0.10)` → hover `0.14`,
  `#f3f0e8`) then Confirm (danger `#d03b3b` → hover `#e34948`, white; `disabled` while `busy`).
- Escape closes (calls `onCancel`); the confirm button is focused on mount.

## Error handling

- **Unauthenticated:** `403` (endpoint) — the menu item is already authed-only, so this is defense
  in depth for direct API callers.
- **Missing song:** `404`. The dialog surfaces a generic failure line and stays open.
- **File removal failure:** `media.Remove` treats a missing file as success; a real removal error is
  logged/ignored best-effort — the row is already gone (matches the app's existing best-effort
  media cleanup, e.g. `songs.go` upload rollback, `fanart.go:45`).
- **Client delete failure (non-2xx):** the dialog shows an error line and remains open for retry.

## Testing

- **Backend** (`go test ./...` green): `library` test — `DeleteSong` removes the row, cascades
  (assert a `plays`/`playlist_songs`/`song_genres` row for the song is gone), returns the file_path,
  and reports `false` for a missing id. `httpapi` test — `DELETE /api/songs/{id}` returns `204` and
  removes the audio file from the media store; `404` for a missing id; `403` for anonymous.
- **Frontend** (`tsc` clean + vitest green): `ConfirmDialog` renders title/message/buttons and
  wires `onConfirm`/`onCancel`; disables confirm when `busy`; shows the `error` line. A test that
  the wired delete removes the song from the list and, when it's the current track, clears the
  player (at whatever unit boundary is cleanest — likely a small pure helper for the state update).
- **Live Playwright e2e**: authenticated, open a song's menu → Delete → confirm → the row
  disappears from the library and `GET /api/songs/{id}` returns 404; Cancel leaves it intact.

## Conventions

Loom design tokens where the app already uses them; the dialog matches loom's hardcoded hexes to
stay visually consistent with the existing loom-mirrored `Menu.tsx`. English only. Inline
`React.CSSProperties` (no Tailwind in `music/ui`). Presence/absence gating (the menu item is authed-
only; no lock icons).

## Assumed defaults (flag if wrong)

- The `ConfirmDialog` is built generic (title/message/danger) so it can be reused later
  (e.g. delete playlist), but this phase only wires it to song delete.
- Post-delete library update uses an in-place `setSongs(filter)` (no full refetch), matching the
  tag-edit precedent.
