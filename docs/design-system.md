# Music — Design System

The single UX pattern for the whole app. **Follow this for every UI change.** When something
here is ambiguous, the visual reference wins: [`docs/mockups/design-system.html`](./mockups/design-system.html)
(open in a browser). Aesthetic is *Warm Editorial, dark* — serif headings, sans body/UI, warm
clay accent. Tokens live in `ui/src/index.css` (`@theme`); shared primitives live in `ui/src/ui.tsx`.

## Foundations

### Typefaces
- **Serif** (`--font-serif`, Anthropic Serif) — *editorial content headings only*: page titles,
  section titles, dialog/drawer titles, headings over artwork, cover-art monograms.
- **Sans** (`--font-sans`, Anthropic Sans) — everything else: body, labels, controls, buttons, tabs.

### Type scale (six steps — use these, nothing in between)
| Token | Size | Use |
|---|---|---|
| `--text-display` | 1.75rem / 28px | Page `<h1>` (serif, wt 500) |
| `--text-title` | 1.25rem / 20px | Section & dialog headings (serif, wt 500) |
| `--text-body` | 1rem / 16px | Body copy, captions under titles (sans) |
| `--text-ui` | 0.9375rem / 15px | Controls, buttons, tabs, pills, menu items (sans) |
| `--text-label` | 0.8125rem / 13px | Field labels, helper/muted text (sans, muted, wt 500) |
| `--text-micro` | 0.6875rem / 11px | Uppercase badges/ribbons (sans, +letter-spacing) |

Immersive hero headings may use `clamp()` between the scale endpoints (fluid over artwork).

### Spacing scale
`--space-1..6` = 4 / 8 / 12 / 16 / 24 / 32px. Field-to-field gap = 24px; label→control = 6px.

### Color tokens & accent roles
Base palette (existing): `--color-bg #1f1f1e`, `--color-panel #1b1b1a`, `--color-active #2c2c2a`,
`--color-border #323230`, `--color-ink #faf9f5`, `--color-muted #9c9a92`.

**Three accents, each with one job — never mix them:**
| Role | Hex | Where |
|---|---|---|
| **accent fill** | `#c25f34` (new, darker orange) | primary buttons · active tab/pill/nav · selection ring · focus ring · slider fill |
| **accent text** | `#d97757` (`--color-accent-strong`) | links · ghost buttons · favorite stars · outline CTAs · dots & ribbons |
| **danger** | `#c14638` (new) | destructive fills · delete confirms · danger menu items |

(`--color-accent #c6613f` stays as the base clay for gradients.) Menus sit on an **elevated**
surface — promote the hardcoded `Menu.tsx` colors to tokens: `--elevated #363632`,
`--elevated-border #454540`, `--elevated-ink #f3f0e8`, `--elevated-hover #3f3f3a`.

### Radius
`--radius-ui: 10px` for controls, buttons, cards. `999px` reserved for pills, search field, and
on-art buttons (intentional). Modals use 14px; heroes/immersive use 16–18px.

## Icons

`lucide-react` via `Icon.tsx` / `Glyph.tsx`, `strokeWidth={1.9}`, 24×24, rounded caps. **No unicode
glyphs, no icon font.** Filled star = `Star` with `fill="currentColor"`; the drag handle `⠿` is the
one intentional literal.

## Components

- **Form controls** (select / input / textarea): `min-height 40px`, `padding 0 12px` (textarea
  `10px 12px`), `font 15px`, `radius 10px`, `bg --color-panel`, `1px --color-border`. Focus =
  2px **accent fill** ring. Textareas resize vertically. Selects drop the native appearance for
  a custom lucide `chevron-down` (`--color-muted`, right 12px).
- **Field label**: 13px, `--color-muted`, wt 500, `margin-bottom 6px`. One label style everywhere
  (retire the old 1rem sentence-case and 0.7rem uppercase variants).
- **Buttons** (all: height 40px, radius 10px, 15px): `primary` accent-fill/ink/600 · `secondary`
  active+border/500 · `ghost` transparent/accent-text/500 · `danger` danger-fill/ink/600 ·
  `small` height 32px/13px. Disabled = `opacity 0.6; cursor default`. **Busy = spinner + label,
  never an ellipsis** ("Generating", not "Generating…").
- **Pills / tabs**: 999px radius, 15px, one active/inactive state (active = accent-fill + ink;
  inactive = transparent + muted). Filter pill uses an accent-text outline + dot.
- **Menus**: elevated surface, 220px min, items 32px min-height / 6px radius / 15px; danger item =
  `#ec7e7e` → hover `#d03b3b`+white; separator `--elevated-border`.
- **Modals / overlays**: open over `rgba(0,0,0,0.5)` + **2px backdrop-blur** (matches loom's
  `SettingsModal`). Apply to **all** overlays. Surface 14px radius, serif title. Close on
  Esc / backdrop / ✕ / Cancel.
  - **Never size a dialog with `dvh` (or `vh`/`svh`).** The `<Overlay>` component (`ui.tsx`) sizes
    itself in JS from `visualViewport`, and `.ui-modal` caps at `max-height: 100%` **of that**.
    This is not a style preference — it is the only way the bottom of a dialog stays reachable on
    iPad, and it is easy to "simplify" back into a bug:
    - iOS never shrinks the **layout viewport** when the software keyboard opens, and every
      viewport unit — `vh`, `svh`, `dvh` — derives from it. `dvh` tracks the address bar
      collapsing, **not** the keyboard. A modal capped at `90dvh` is 751px tall on an iPad in
      landscape while only ~484px is visible, so its pinned footer sits ~255px below the fold.
    - **Scrolling cannot rescue it.** A scrollbar moves content *inside* a box; the footer is not
      in the scrolling body, and the modal's own bottom edge is already below the fold. Going
      full-screen makes it *worse* — the footer then sits exactly at the viewport bottom, which
      the keyboard always covers.
    - WebKit implements neither `interactive-widget=resizes-content` (the one-line CSS fix,
      Android-only, [WebKit bug 259770](https://bugs.webkit.org/show_bug.cgi?id=259770), open and
      unassigned since 2023) nor the VirtualKeyboard API. `visualViewport` is the only surface
      that reports the visible band. There is no CSS-only fix.
    - **Known fragility:** an iPadOS 26 bug leaves `visualViewport.offsetTop` un-reset after the
      keyboard closes (26.0, partly fixed in 26.1). If dialogs ever sit slightly offset after
      typing, start there — don't rip out the hook.
  - `.ui-overlay` needs a **definite grid row** (`grid-template-rows: minmax(0, 1fr)`) or
    `max-height: 100%` on the modal is self-referential against an `auto` track and silently does
    nothing.
  - **Use the `<Overlay>` component (`ui.tsx`), never a bare `className="ui-overlay"`.** The class
    alone does not size itself — `<Overlay>` calls the hook. A hand-rolled div would sit at the
    layout viewport's height and bury its footer under the keyboard, i.e. *worse* than the `90dvh`
    this replaced. `ConfirmDialog`, `GenreEditor`, `AddToPlaylist` and `QueueDrawer` still
    hand-roll their overlays and inherit none of this; migrate them onto `<Overlay>`.
  - **Deliberate side effect on desktop:** the cap is now the overlay's content box (visible
    height − 32px) rather than `90dvh`, so a *very tall* dialog may run ~7% taller and its gutter
    is a flat 16px instead of a proportional ~54px. Accepted: it spends the visible band where the
    band is scarce, and no current dialog is tall enough to reach either cap on a desktop window.
- **Search field**: 999px pill, leading search icon, borderless 15px input.
- **Cards / tiles**: cover art falls back to a serif monogram on `--color-active`. Ribbons =
  `rgba(0,0,0,.5)` 999px 11px + accent-text dot. Chips = active 999px 13px with ✕. Dashed tile =
  "add" affordance. Tinted CTA = accent-text on `color-mix(accent-text 12%)`.
- **Sliders**: native range, accent-fill track/thumb (seek only; there is no volume slider).
- **Home hero**: full-bleed panel that cycles the **top three most-played songs** as an
  **infinite, forward-only carousel** — after #3 it slides on to #1, never snapping backward.
  Each slide is **song-centric** — serif song title, `#N most played · genre` eyebrow (genre
  links trail it). The **Play/Download/Share action row is stationary** (pinned bottom-left,
  acting on the current slide) while only the artwork + eyebrow/title/artist slide. The panel is
  focusable for ← → but its default focus ring is suppressed (it framed the whole hero). The #1 slide is backed by the starred `is_hero` fanart;
  #2/#3 by each song's own cover under a dark gradient. **Plain pill dots centred at the bottom**
  (active dot = accent-text, same size — no elongation). The slide is a controlled **~650ms**
  transform; it **auto-advances every ~30s**, paused on hover/focus/drag and restarted after any
  manual move so each slide keeps its full dwell. Swipe/drag or ← →. Under `prefers-reduced-motion`
  slides jump instantly and auto-advance is off. Collapses to a single static panel with one or
  zero songs (no dots, no auto-advance).
- **Player**: docked bar (now-playing 15/13, transport icon buttons, circular accent play, seek).
  Expanded player = big cover + serif white title on a gradient.
- **Nav**: desktop rail (44px icon buttons, subtle grey active) + mobile tab bar (icon over
  11px label, accent-fill active).
- **Queue drawer / detail glass panel / account slot / top-result card** — see the mockup.
- **Feedback**: toast (999px pill + progress bar), loading (spinner + muted text), empty-state
  (serif title + CTA), inline error (accent-text).
- **Rank numbers**: tabular figures, plain `1/2/3` (no `01/02/03` padding), accent-text top 3.
- **Never show a play count outside the tag editor's Info tab.** The top-ten chart shows **rank
  only** — a rank says what the chart is for without putting a number on the song. This is a
  product rule, not a layout accident: the count was once shown on desktop and hidden below 720px,
  and it is now shown nowhere. `#N most played` (hero eyebrow) and the "Top ten played" heading are
  fine — neither states a count. `/api/home` still carries `plays` on each entry because the server
  orders by it; **don't render it.**

## Behavior

- **Spin on every async wait** — LLM calls, uploads, saves all show the spinner state.
- **Stream every LLM answer** — text streams token-by-token into the target field; the input is
  **locked (disabled) until the stream completes**, then unlocks. **Omit reasoning** — stream only
  the answer. Rationale: streaming keeps something visibly happening, so the wait feels shorter than
  a spinner on an empty box. Applies to Studio "Suggest prompt" & "Refine" (both are LLM calls, not
  instant actions). *(Requires backend SSE / chunked responses — a separate workstream.)*

## Key patterns & decisions

- **Scroll indicators — match the content shape, don't unify the widget.** Two deliberate
  patterns, chosen by what's being scrolled:
  - **Dots** — a small, fixed, ranked/countable set where *position matters* (the 3-slide home
    hero). Dots show count and current position.
  - **Edge fade + ‹ › chevrons** (`HScrollRail`) — a long, continuous rail of *N* cards where
    "page 4 of 17" is meaningless (genre cover rails, "Recently added"). The scrollable edge
    fades and floats a chevron; short non-overflowing rails show neither.

  Never mix them the wrong way: no dots on card rails, no chevron/fade on the hero.
- **MP3 tag editor = tabbed editor**: **Details / Cover / Lyrics / Info** tabs, **centered modal on
  desktop, full-screen on mobile** (≤720px), over the blurred backdrop. Tabs keep each screen short
  as the form grows. Replaces the old single-scroll `TagEditor.tsx`.
  - All panels share **one grid cell** sized to the tallest (Details), and toggle `visibility`
    rather than `display`. Deliberate, and worth keeping: it holds the modal at a constant height
    so the frame doesn't jump between tabs, and keeps every panel mounted so unsaved edits survive
    a tab switch. The price is trailing whitespace on the short tabs (Cover, Info). Don't "fix" it
    into per-tab heights without accepting the jump.
  - **Info tab** — read-only, grouped **Playback · Audio · File**: Plays · Last played ·
    Bitrate · Sample rate · Channels · Duration · Size · Added. The **only** place in the app that
    shows a play count (see the rank-numbers rule above). Plays are **lifetime**
    (`GET /api/songs/{id}/stats`, editor-only), deliberately unlike the top-ten chart's rolling
    30-day window — a song's own stats should mean what they say. `fileSize` is the **stored**
    file's size; tags are baked in at download time, so a download differs slightly.
    - **Audio info is 0 = unknown, and renders `—`.** A row imported before migration 0006 has
      NULL until the background backfill reaches it, and a file that won't decode stays unknown
      forever. Never render a confident `0 Hz` / `0 kbps`; duration already degrades this way.
    - **Bitrate is an average, derived — not read from a frame header.** A frame header's rate is
      exact for CBR and *wrong* for VBR (it describes frame 1, not the file), which would drag in
      Xing detection and frame counting. `audio bytes × 8 ÷ duration ms` is an average by
      construction, so it's right for both. It needs the **audio** bytes (ID3 tags, especially an
      imported cover, are not audio) and the **decoder's** duration, not a container's rounded
      claim — verified against ffprobe on `testdata/sample.mp3`: 128 kbps exactly, where the naive
      file-size ÷ container-duration gives 133. See `backend/internal/metadata/audio.go`.
    - Timestamps from the API are SQLite `datetime('now')` — **UTC with no zone marker**, a shape
      `Date` parses as *local*. Always go through `format.ts` (`formatDateAdded`,
      `formatLastPlayed`); never `new Date(apiTimestamp)` directly.
  - **Lyrics tab** holds a tall textarea plus a **"Clean"** action that strips Suno bracketed
    directives (`[Verse]`, `[Chorus]`, `[Guitar solo]`, …) via a `cleanLyrics` helper — kept in
    sync with the server-side `cleanLyrics` in `backend/internal/metadata/mp3.go`. Leave `()`
    ad-libs intact. The `lyrics` field is `Song.lyrics?` / `SongEdit.lyrics` in `api.ts`, persisted
    to ID3 + the `song_lyrics` migration.
  - **Coordinate with the in-flight `worktree-lyrics-editor` branch** (adds the lyrics field
    end-to-end + the Clean button on the *old* modal). The tabbed redesign must **build on that
    branch's work**, not discard it — land/merge lyrics first, then restructure into tabs.
- **Queue control** (top chrome): icon-only 40px ghost button (list icon, tooltip "Queue").

## Copy — the ellipsis rule

Always the character **…** (U+2026), never three dots. A trailing `…` means the command **opens
more UI to gather input** before it acts — "Edit tags…", "Add to playlist…", "Replace cover…",
"New playlist…", "Upload…". Do **not** use `…` for: immediate actions (Play, Save changes,
Generate, Refine, Sign in); a command that only opens a confirmation ("Delete playlist"); or busy
labels (the spinner is the signal). Placeholder hints ("Search…") are a separate, accepted idiom.

## Responsive

Single breakpoint at **720px** (matches `.app-shell` / rail). Below it: desktop rail → mobile tab
bar, and modals/sheets → full-screen. Wide content scrolls inside its own container; the page body
never scrolls sideways.

**One documented exception:** `.ui-modal` also goes full-screen on touch tablets up to 1024px
(`(min-width: 721px) and (max-width: 1024px) and (pointer: coarse)` — iPad portrait/landscape),
where a centered dialog leaves the footer cramped against the viewport edge. A large *touchscreen
desktop* (>1024px) keeps the centered modal. This is the only place a second breakpoint is
sanctioned; don't add more.
