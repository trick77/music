# Player-state deep URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a URL (`/song/:id?player=lyrics`) open the full-screen player directly into lyrics/karaoke mode for a song, with the scheme extensible to other player states.

**Architecture:** A pure reader parses `?player=<state>` from the query string (routing/`parsePath` untouched — it already ignores the query string). `App` detects the param on the `song` route, hands a one-shot open-intent to `PlayerBar`, then strips the param from the URL via `replaceState`. `PlayerBar` applies the intent once (`setFull`/`setLyricsMode`) and reports it consumed. Player UI state stays local to `PlayerBar`; the URL is an entry-point signal, not a live binding.

**Tech Stack:** Vite + React 19 + TypeScript, Vitest (unit), Playwright MCP (integration against the running app).

## Global Constraints

- English only in code/comments/docs.
- TDD: failing test first, then minimal implementation.
- Conventional commits; never commit to `master` (work on `feat/player-deep-urls`).
- Frontend: React 19 + TS + Tailwind v4. lucide icons only (strokeWidth 1.9). No AI branding/wordmark in UI copy.
- Validate every runnable change with Playwright against the running app — real navigation/clicks/assertions, not only unit tests.
- Anonymous users can read/play/download/share; the lyrics-link affordance is therefore available to anonymous users too (no auth gate).
- Frontend tests: `make fe-test` (Vitest). Build: `make fe-build`.

---

### Task 1: Parse and clear the `player` query param (`router.ts`)

**Files:**
- Modify: `ui/src/router.ts`
- Test: `ui/src/router.test.ts`

**Interfaces:**
- Consumes: nothing (pure string parsing + `window.history`).
- Produces:
  - `type PlayerParam = "lyrics" | "full"`
  - `parsePlayerParam(search: string): PlayerParam | null` — reads the `player` key from a query string (leading `?` optional); returns `"lyrics"` or `"full"`, else `null`.
  - `clearPlayerParam(): void` — removes the `player` key from the current URL via `history.replaceState`, preserving the pathname and any other query keys; no navigation event fired.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/router.test.ts`:

```typescript
import { parsePlayerParam } from "./router";

describe("parsePlayerParam", () => {
  it("reads player=lyrics", () => {
    expect(parsePlayerParam("?player=lyrics")).toBe("lyrics");
  });
  it("reads player=full", () => {
    expect(parsePlayerParam("?player=full")).toBe("full");
  });
  it("tolerates a missing leading question mark", () => {
    expect(parsePlayerParam("player=lyrics")).toBe("lyrics");
  });
  it("returns null when the param is absent", () => {
    expect(parsePlayerParam("?foo=bar")).toBeNull();
    expect(parsePlayerParam("")).toBeNull();
  });
  it("returns null for an unknown player value", () => {
    expect(parsePlayerParam("?player=wat")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/router.test.ts`
Expected: FAIL — `parsePlayerParam is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `ui/src/router.ts` (after `parsePath`):

```typescript
export type PlayerParam = "lyrics" | "full";

// parsePlayerParam reads the deep-link ?player=<state> value from a query string.
// Routing (parsePath) ignores the query string; this is the only reader of it.
export function parsePlayerParam(search: string): PlayerParam | null {
  const v = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("player");
  return v === "lyrics" || v === "full" ? v : null;
}

// clearPlayerParam strips ?player= from the current URL without navigating, so the
// deep-link intent fires exactly once and later manual toggles aren't fought by a
// stale URL. Entry-point-only semantics.
export function clearPlayerParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("player");
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/router.test.ts`
Expected: PASS (all `parsePath` and `parsePlayerParam` tests green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/router.ts ui/src/router.test.ts
git commit -m "feat(router): parse and clear ?player deep-link param"
```

---

### Task 2: `lyricsShareUrl` helper (`share.ts`)

**Files:**
- Modify: `ui/src/share.ts`
- Test: `ui/src/share.test.ts`

**Interfaces:**
- Consumes: nothing (uses `location.origin`, like the sibling helpers).
- Produces: `lyricsShareUrl(id: string): string` → `${location.origin}/song/${id}?player=lyrics`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/share.test.ts` — update the import and add a case:

```typescript
import { songShareUrl, playlistShareUrl, lyricsShareUrl } from "./share";

// ...inside describe("share urls", ...):
  it("builds an absolute lyrics deep-link url", () => {
    expect(lyricsShareUrl("abc")).toBe("https://music.example.com/song/abc?player=lyrics");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/share.test.ts`
Expected: FAIL — `lyricsShareUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `ui/src/share.ts` (after `playlistShareUrl`):

```typescript
// lyricsShareUrl is the deep link that opens the full player in lyrics mode.
export function lyricsShareUrl(id: string): string {
  return `${location.origin}/song/${id}?player=lyrics`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/share.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/share.ts ui/src/share.test.ts
git commit -m "feat(share): add lyricsShareUrl deep-link helper"
```

---

### Task 3: Wire the open-intent through `App` into `PlayerBar`

**Files:**
- Modify: `ui/src/App.tsx` (add intent state/effect near the route usage; pass props to `PlayerBar` at `ui/src/App.tsx:293`)
- Modify: `ui/src/PlayerBar.tsx` (props on the `PlayerBar` component at `ui/src/PlayerBar.tsx:78`; consume effect)

**Interfaces:**
- Consumes: `parsePlayerParam`, `clearPlayerParam` (Task 1); `PlayerParam` type.
- Produces: `PlayerBar` gains two optional props:
  - `openIntent: PlayerParam | null` — one-shot request to open the player.
  - `onIntentConsumed: () => void` — called after the intent is applied so `App` clears it.

- [ ] **Step 1: Add the consume effect + props to `PlayerBar`**

In `ui/src/PlayerBar.tsx`, update the import and component signature.

Change the import line (currently `import { getAlign, postAlign, type AlignmentData, type Song } from "./api";`) — leave it, and add a router import at the top of the file:

```typescript
import { type PlayerParam } from "./router";
```

Change the component signature (`ui/src/PlayerBar.tsx:78`) from:

```typescript
export function PlayerBar({ fav, onShare, alignmentEnabled }: { fav: Fav; onShare: (s: Song) => void; alignmentEnabled: boolean }) {
```

to:

```typescript
export function PlayerBar({ fav, onShare, alignmentEnabled, openIntent = null, onIntentConsumed }: { fav: Fav; onShare: (s: Song) => void; alignmentEnabled: boolean; openIntent?: PlayerParam | null; onIntentConsumed?: () => void }) {
```

Add this effect immediately after the existing `align` state declarations (after `ui/src/PlayerBar.tsx:82`, before the `song` const is fine too — place it just after the two `useEffect` blocks, before `if (!p.current || !song) return null;`):

```typescript
  // Apply a deep-link open-intent (?player=…) exactly once. Runs even before a
  // track has loaded — full/lyricsMode persist, so the full player appears as soon
  // as the song is in the player. The song-change effect above keeps lyricsMode
  // only when the loaded track can actually do karaoke (graceful degradation).
  useEffect(() => {
    if (!openIntent) return;
    setFull(true);
    if (openIntent === "lyrics") setLyricsMode(true);
    onIntentConsumed?.();
  }, [openIntent, onIntentConsumed]);
```

- [ ] **Step 2: Add intent state + effect in `App` and pass props**

In `ui/src/App.tsx`, extend the existing router import at `ui/src/App.tsx:17` from:

```typescript
import { useRoute, navigate } from "./router";
```

to:

```typescript
import { useRoute, navigate, parsePlayerParam, clearPlayerParam, type PlayerParam } from "./router";
```

Add intent state alongside the other `useState` hooks in the `App` component:

```typescript
  const [openIntent, setOpenIntent] = useState<PlayerParam | null>(null);
```

Add this effect after the route is available (`const route = useRoute();` already exists at `ui/src/App.tsx:50`; place the effect after the restore effect):

```typescript
  // Deep-link entry point: when a /song/:id URL carries ?player=…, capture the
  // intent for the player and strip the param so it fires once and the URL settles
  // to a clean /song/:id (entry-point-only, no history pollution).
  useEffect(() => {
    if (route.name !== "song") return;
    const mode = parsePlayerParam(window.location.search);
    if (mode) {
      setOpenIntent(mode);
      clearPlayerParam();
    }
  }, [route]);
```

Update the `PlayerBar` usage at `ui/src/App.tsx:293` from:

```tsx
      <PlayerBar fav={fav} onShare={shareSong} alignmentEnabled={!!session?.alignmentEnabled} />
```

to:

```tsx
      <PlayerBar fav={fav} onShare={shareSong} alignmentEnabled={!!session?.alignmentEnabled} openIntent={openIntent} onIntentConsumed={() => setOpenIntent(null)} />
```

- [ ] **Step 3: Type-check and build the frontend**

Run: `make fe-build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 4: Run the frontend unit suite**

Run: `make fe-test`
Expected: PASS (no regressions).

- [ ] **Step 5: Playwright-verify the deep link (against the running app)**

Start the app if not running: `make docker-dev` (serves on :8080 with dev autologin).

Using the Playwright MCP browser tools:
1. Pick a song id that has lyrics (open the app, note a song id from a `/song/:id` link, ideally one already karaoke-synced).
2. `browser_navigate` to `http://localhost:8080/song/<id>?player=lyrics`.
3. `browser_snapshot` — assert the full-screen player is open AND the lyrics/karaoke view (or the "Generate karaoke"/needs card for a lyrics-but-unsynced song) is visible, NOT the artwork view.
4. Assert the address bar is now `http://localhost:8080/song/<id>` (param stripped) — check via `browser_evaluate` returning `location.search` (expect `""`).
5. Navigate to `http://localhost:8080/song/<id-without-lyrics>?player=lyrics` → assert the full player opens on the artwork view without crashing.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/PlayerBar.tsx
git commit -m "feat(player): open full/lyrics player from ?player deep link"
```

---

### Task 4: "Copy lyrics link" action in the song menu

**Files:**
- Modify: `ui/src/SongMenu.tsx` (add prop + menu item)
- Modify: `ui/src/App.tsx` (wire the action at the `SongMenu` usage, `ui/src/App.tsx:229`)

**Interfaces:**
- Consumes: `lyricsShareUrl` (Task 2), existing `copyText` (already imported in `App.tsx`).
- Produces: `SongMenu` gains `onCopyLyricsLink: () => void`.

- [ ] **Step 1: Add the prop and menu item to `SongMenu`**

In `ui/src/SongMenu.tsx`, add to the `Props` type (after `onShare: () => void;`):

```typescript
  onCopyLyricsLink: () => void;
```

Add the menu item right after the existing Share item (`ui/src/SongMenu.tsx:40`). Gate it on the song having lyrics — a lyrics link is meaningless with no lyrics (the player would fall back to artwork). No auth gate (anonymous may share):

```tsx
        {!!p.song.lyrics && p.song.lyrics.trim() !== "" && (
          <MenuItem icon="music" onClick={p.onCopyLyricsLink}>Copy lyrics link</MenuItem>
        )}
```

- [ ] **Step 2: Add a copy handler in `App` and wire the prop**

In `ui/src/App.tsx`, add a handler next to `shareSong` (around `ui/src/App.tsx:180`). Update the `share` import to include `lyricsShareUrl`:

```typescript
import { songShareUrl, lyricsShareUrl, copyText } from "./share";
```

Add the handler:

```typescript
  const shareLyricsLink = async (song: Song) => {
    const url = lyricsShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
  };
```

Wire it into the `SongMenu` usage (`ui/src/App.tsx:229`) by adding the prop (place next to `onShare`):

```tsx
            onCopyLyricsLink={() => { setMenuFor(null); shareLyricsLink(song); }}
```

- [ ] **Step 3: Type-check and build**

Run: `make fe-build`
Expected: build succeeds; TypeScript enforces the new required `onCopyLyricsLink` prop is passed at every `SongMenu` usage.

- [ ] **Step 4: Run the frontend unit suite**

Run: `make fe-test`
Expected: PASS.

- [ ] **Step 5: Playwright-verify the menu action**

Using the Playwright MCP browser tools against the running app:
1. Open the app, find a song row with lyrics, click its "more" (⋮) button.
2. `browser_snapshot` — assert a "Copy lyrics link" item is present.
3. Click it; `browser_evaluate` reading `navigator.clipboard.readText()` (or intercept the prompt) — assert the copied text ends with `/song/<id>?player=lyrics`.
4. Open a song row WITHOUT lyrics → assert "Copy lyrics link" is absent.

- [ ] **Step 6: Commit**

```bash
git add ui/src/SongMenu.tsx ui/src/App.tsx
git commit -m "feat(menu): add Copy lyrics link action"
```

---

## Self-Review

**Spec coverage:**
- URL scheme `?player=lyrics` / `?player=full` → Task 1 (`parsePlayerParam`).
- Entry-point-only + URL strip → Task 1 (`clearPlayerParam`) + Task 3 (App effect).
- Open full/lyrics player from the link → Task 3.
- Autoplay best-effort → inherited (existing `SongPage` `onPlay` on the `song` route; no new code needed — noted here so it isn't mistaken for a gap).
- Graceful degradation (no lyrics → artwork/needs card, no crash) → Task 3 relies on `PlayerBar`'s existing `canKaraoke` reset (`ui/src/PlayerBar.tsx:90-93`) + render branch (`:181`); verified in Task 3 Step 5.5.
- Share affordance → Task 2 (`lyricsShareUrl`) + Task 4 (menu item).
- Testing: unit (Tasks 1, 2) + Playwright (Tasks 3, 4).

**Placeholder scan:** none — all steps carry concrete code/commands.

**Type consistency:** `PlayerParam` defined in Task 1, imported by Tasks 3. `openIntent`/`onIntentConsumed` names match between `PlayerBar` (Task 3 Step 1) and `App` (Task 3 Step 2). `onCopyLyricsLink` matches between `SongMenu` (Task 4 Step 1) and `App` (Task 4 Step 2). `lyricsShareUrl` matches Task 2 and Task 4.

**Note for implementer:** `App.tsx` may import router symbols on an existing line; merge the new imports (`parsePlayerParam`, `clearPlayerParam`, `PlayerParam`) into that line rather than adding a duplicate `from "./router"` import. Same for the `./share` import in Task 4.
