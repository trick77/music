# Player-state deep URLs

**Date:** 2026-07-12
**Status:** Approved (design)

## Goal

Give the app deep-link capability so a URL can open the player directly into a
specific state. The first — and motivating — case is **lyrics mode**: a URL that
opens the full-screen player with the karaoke/lyrics view active for a given song.
The scheme is designed to be extensible to other player states without reworking
routing.

## Scope

- **In scope:** a `?player=<state>` query param on the existing song route that,
  on load, opens the player into that state; a share affordance to copy the
  lyrics link.
- **Out of scope:** continuously mirroring live player state back into the URL
  (rejected — chosen behavior is *entry point only*); making arbitrary app states
  URL-addressable; encoding playback position (`&t=`) — reserved for a later pass.

## Key decisions

1. **Breadth:** general player-state URLs, with `lyrics` as the first value.
2. **Behavior:** *entry point only.* The URL opens a state; once open, manual
   toggling of lyrics/expand does **not** rewrite the URL. No history-stack
   pollution; predictable back button.
3. **URL shape:** query param on the existing song route
   (`/song/:id?player=lyrics`). `parsePath` already ignores the query string, so
   routing is untouched — least code, extensible for free.
4. **Autoplay:** best-effort. Loading the song attempts playback (existing
   `SongPage` behavior). Browsers may block audio without a prior gesture; if so
   the player opens **paused** and the user taps play. No error is shown.

## URL scheme

`?player=<state>` appended to the song route:

| URL                              | Effect                                          |
| -------------------------------- | ----------------------------------------------- |
| `/song/:id?player=lyrics`        | Open full player, lyrics mode active            |
| `/song/:id?player=full`          | Open full player, artwork (reserved/extensible) |
| `/song/:id` (no param)           | Unchanged — song page, player loads as today    |

Unknown `player` values are ignored (treated as no param).

## Architecture & flow

Player UI state (`full`, `lyricsMode`) stays local to `PlayerBar.tsx`. The URL is
an **entry-point signal** consumed once, not a live binding.

1. Route resolves to `{ name: "song", id }` → `SongPage` mounts → existing
   `onPlay(song)` loads the song into the player and attempts playback.
2. `App` reads the `player` value from `location.search` once (via a small pure
   reader in `router.ts`) and passes the intent down to `PlayerBar`.
3. `PlayerBar` applies the intent exactly once: `player=lyrics` →
   `setFull(true); setLyricsMode(true)`; `player=full` → `setFull(true)`.
4. The intent is then **cleared from the URL** via `history.replaceState` (drop
   the query string, keep the path). This ensures:
   - re-renders / the back button do not re-fire the intent,
   - later manual toggles are not fought by a stale URL,
   - the visible URL settles to the clean `/song/:id`.

### Components touched

- **`router.ts`** — add `parsePlayerParam(search: string): "lyrics" | "full" | null`
  (pure; unit-tested). `parsePath` is unchanged. Add a helper to strip the query
  string via `replaceState`.
- **`App.tsx`** — read the player param when the route is `song`; pass a
  one-shot intent prop to `PlayerBar`.
- **`PlayerBar.tsx`** — accept the intent; apply once on change; trigger the URL
  strip after applying.
- **`share.ts`** — add `lyricsShareUrl(id: string): string` returning
  `${location.origin}/song/${id}?player=lyrics`.
- **`SongMenu.tsx`** — add a "Copy lyrics link" action using `lyricsShareUrl` +
  existing `copyText` fallback pattern.

## Graceful degradation

If `player=lyrics` but the song has no lyrics/alignment, `PlayerBar`'s existing
`canKaraoke === false` path already renders the "needs generation" card / plain
artwork. The player still opens full-screen; no error. `setLyricsMode(true)` is
still set so the view switches as soon as lyrics become available.

## Error handling

- Unknown/malformed `player` value → ignored, no player state change.
- Song id not found → existing `SongPage` "Loading song… / Home" fallback; the
  player intent simply never fires because no song loads.
- Autoplay blocked by the browser → player opens paused; no error surfaced.
- Clipboard unavailable (insecure context) → existing `copyText` returns false;
  caller falls back to the existing prompt pattern (as other share links do).

## Testing

- **Unit (`router.test.ts`):** `parsePlayerParam` for `?player=lyrics`,
  `?player=full`, unknown value, and no param.
- **Unit (`share.test.ts`):** `lyricsShareUrl(id)` shape.
- **Playwright (required by AGENTS.md):**
  1. Navigate to `/song/:id?player=lyrics` for a song with lyrics → assert the
     full player is open and the lyrics/karaoke view is visible.
  2. Assert the URL has settled to `/song/:id` (param stripped).
  3. Navigate to `/song/:id?player=lyrics` for a song **without** lyrics → assert
     the full player opens and shows the needs-generation/artwork fallback (no
     crash).
  4. "Copy lyrics link" in the song menu copies the expected URL.
