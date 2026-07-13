# Player-state deep URLs

**Date:** 2026-07-12
**Status:** Approved (design) — revised 2026-07-13 to live URL mirroring

## Goal

Give the app deep-link capability so a URL can open the player directly into a
specific state, and — the other direction — so that whenever the player is open the
address bar *is* a shareable link to exactly that state. The motivating case is
**lyrics mode**: a URL that opens the full-screen player with the karaoke/lyrics view
active for a given song, and a player from which that URL is trivially obtainable.

## Scope

- **In scope:** a `?player=<state>` query param on the song route that opens the player
  into that state on load; **live mirroring** of the open player's state back into the
  URL so the address bar always holds the shareable link; a Share control inside the
  player that copies it. States: `lyrics` (karaoke view) and `full` (artwork view).
- **Out of scope:** playback position / timestamps (`&t=`); restoring queue or playlist
  context; making arbitrary app states URL-addressable.

## Revision note (why the original was replaced)

The first cut was *entry-point only*: the param was stripped the instant it opened the
player (`clearPlayerParam`), so the address bar never reflected that you were in the
lyrics player, and the only way to get a link was a buried row-menu item. That was the
core complaint. The player is now driven **from the URL as the single source of truth**,
mirrored live. The entry-point-only rationale and `clearPlayerParam` are removed.

## URL scheme

`?player=<state>` on the song route:

| URL | Effect |
| --- | --- |
| `/song/:id?player=lyrics` | Full player open, lyrics/karaoke view, for `:id` |
| `/song/:id?player=full` | Full player open, artwork view, for `:id` |
| `/song/:id` (no param) | Song landing page; plays the song, player not auto-opened |
| any other route | Mini-bar only |

Unknown `player` values are ignored (treated as no param). The full player is always
anchored to `/song/:nowPlayingId`, so the address bar is always a valid deep link.

## Architecture & flow

Player-overlay UI state (`open`, `lyrics`) is **derived from the URL**, not local
component state. `App` reads `parsePlayerParam(location.search)` each render;
`useRoute` re-renders on `popstate`, and the URL helpers dispatch a synthetic
`popstate` (native `pushState`/`replaceState` don't), so a change to the address bar
flows straight to the render.

- **Open** (expand mini-bar / tap lyrics icon): `pushPlayer(nowPlayingId, mode)` —
  `pushState` one history entry so Back and the close button return to the prior page.
- **Toggle** artwork↔lyrics while open: `replacePlayer` — no new entry.
- **Track advance** while open (next/prev/queue): a resync effect `replacePlayer`s the
  path to the new now-playing id, keeping the link honest without stacking history.
- **Close** (X): `closePlayer(pushed)` — `history.back()` when we pushed the entry, else
  `replaceState` to `/song/:id` (drop the param) for a fresh deep-link arrival.
- **Browser Back** pops the pushed entry → param gone → player closes.
- **Share** in the player copies `location.href` (already the correct deep link).

### Coupling guards (global overlay bound to a per-song route)

Because opening routes to `/song/:nowPlayingId`, two side-effects are guarded:

1. **`SongPage`** plays its song only when it isn't already the now-playing track —
   otherwise expanding the player would re-enter `SongPage` and toggle playback to a
   pause.
2. **Session restore** (last track, no autoplay) is skipped on a `/song/:id` landing —
   that page plays its own song, and seeding the resumed track first would let the
   resync effect hijack the URL to it.

### Components touched

- **`router.ts`** — `parsePlayerParam` (kept); `pushPlayer` / `replacePlayer` /
  `closePlayer` (new); `clearPlayerParam` removed.
- **`App.tsx`** — derive `playerParam`; `pushedPlayer` ref; reset + resync effects;
  `expandPlayer` / `setPlayerMode` / `closePlayerView` / `copyPlayerLink`; restore &
  `SongPage` guards.
- **`PlayerBar.tsx`** — `open` / `lyrics` props + callbacks replace internal `full` /
  `lyricsMode` state; downgrade effect; in-player Share copies the live URL.
- **`share.ts` / `SongMenu.tsx`** — `lyricsShareUrl` + row-menu "Copy lyrics link" kept
  (now consistent with the address bar).

## Graceful degradation

`?player=lyrics` on a song without lyrics / with alignment disabled → the player opens
on artwork (existing `canKaraoke` fallback) and a downgrade effect `replacePlayer`s the
param to `=full`, so the link stays honest. No error.

## Error handling

- Unknown/malformed `player` value → ignored.
- Song id not found → existing `SongPage` "Loading song…/Home" fallback; the overlay
  never renders because no song loads.
- Autoplay blocked by the browser → player opens paused; no error surfaced.
- Clipboard unavailable → `copyText` returns false; caller falls back to the prompt.

## Testing

- **Unit (`router.test.ts`):** `parsePlayerParam`; `pushPlayer`/`replacePlayer`/
  `closePlayer` history + popstate behavior.
- **Unit (`share.test.ts`):** `lyricsShareUrl(id)` shape.
- **Playwright:**
  1. Expand from `/library` → URL `/song/:id?player=full`, playback still playing.
  2. Toggle lyrics → `?player=lyrics`, no extra history entry; Back closes, returns to `/library`.
  3. Deep link `/song/:id?player=lyrics` (has lyrics) → lyrics view; owner-with-resume lands on `:id`, not the resumed track.
  4. In-player Share copies the current deep URL.
  5. `?player=lyrics` on a no-lyrics song → artwork, URL downgrades to `?player=full`.
  6. Regression: normal in-app lyrics toggle still opens the karaoke view.
