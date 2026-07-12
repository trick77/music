# Studio — Suno-prompt generation from a named song — design spec

**Status:** approved — ready for implementation · **Date:** 2026-07-10 · **Phase:** 9 ·
**Visual reference:** claude.ai artifact published during design
(`https://claude.ai/code/artifact/8a89a7db-ddc7-41f7-8be4-9e9852965f16`).

---

## 1. Context & goal

Studio is the one feature the original design spec
([`2026-07-09-music-player-design.md`](2026-07-09-music-player-design.md) §2) reserved for "later" —
today it is a greyed `Studio — soon` rail slot (`ui/src/Rail.tsx:109`). This phase turns it into a
live, **authenticated-only** tool.

The library is full of AI-created songs. A user who wants to make a *new* AI song "in the vein of" a
real reference track — e.g. `Metallica, Enter Sandman` — otherwise has to hand-craft a Suno prompt.
Studio does that for them: you name a song, MiMo 2.5 Pro **researches it on the web** (the model does
not reliably know a given song's details or lyrics), and returns three things you paste into Suno:

1. a **Style prompt** (comma-separated style/genre tags),
2. **original theme-matched lyrics** (a new song on the theme, no verbatim lines → no copyright), and
3. an **epoch-correct cover-art prompt** (text only; for a future image-gen hookup).

This is **prompt generation only**. Actual Suno audio generation and wiring the cover-art prompt into
the image generator remain deferred (original spec §39).

## 2. Access model

Studio is visible only when the session flag `studioEnabled === true`, i.e.
`cfg.StudioEnabled() && id.Authenticated`. All authenticated users have access — sessions are already
group-gated at login (Phase 7), so "authenticated" already means "in the allowed group"; Studio adds
no further restriction. **Anonymous or key-less instances see nothing** — no rail slot, no `/studio`
route, no session flag. This preserves the app's presence-vs-absence model (no lock icons, no disabled
states) and carries **no AI branding/wordmark** in any anonymous-visible copy (the rail slot is only
rendered for authenticated users anyway).

## 3. User flow

1. Authenticated user opens `/studio` (rail `✦` slot, or direct URL).
2. Types a song reference into a single free-text field (`Metallica, Enter Sandman`) and submits
   (Enter or the **Generate** button).
3. MiMo runs a bounded web-research loop, then the three result cards populate.
4. Each card has a **Copy** button (reusing `copyText` from `ui/src/share.ts` with the `window.prompt`
   fallback).
5. The lyrics card has a **Refine** row: a free-text instruction (e.g. `do not say lullaby`,
   `darker chorus`) + button re-runs MiMo to rewrite **only the lyrics**, leaving the style prompt and
   cover-art prompt untouched.
6. **Reset:** results always reflect the *last generated* reference. Submitting the field clears all
   three outputs, shows a loading state, and regenerates. Editing the field does nothing until submit
   (a stray edit never wipes results); when the field diverges from the reference that produced the
   visible results, a faint "Press Enter to regenerate" hint appears. No separate Reset button.

Nothing is persisted — results are **ephemeral**, shown once. No DB table, no migration change.

## 4. Output contract

- **Style prompt** — comma-separated, **no spaces after commas**, ≤500 chars. No real artist/band/song
  names (per the `suno-prompt-generator` skill rules). Era/genre inferred from the song's sonic
  aesthetic.
- **Lyrics** — *original* words matching the researched theme/mood, structured with Suno meta/structure
  tags. Never the reference song's actual words.
- **Cover-art prompt** — a prose image description that **bakes in the researched genre + era/epoch** so
  the aesthetic is period-correct (e.g. a 1991 thrash-metal cover, not a modern one). No text in the
  image, square album composition.

### Suno tag literacy

The system prompt teaches the model what Suno's meta/structure tags are and that they belong in the
lyrics, with a seed list — structure: `[Intro]`, `[Verse]`, `[Pre-Chorus]`, `[Chorus]`,
`[Post-Chorus]`, `[Bridge]`, `[Hook]`, `[Instrumental]`, `[Guitar Solo]`, `[Break]`, `[Build]`,
`[Drop]`, `[Outro]`, `[Fade Out]`; performance cues: `[Whispered]`, `[Spoken Word]`, `[Belted]`,
`[Big Finish]`, `[Instrumental Break]`. Because Suno's supported tags change over time, the research
loop is **also** instructed to web-search current Suno prompt/meta tags and prefer tags it confirms are
current. The seed list is a floor, not a ceiling.

## 5. Architecture — mirror the imagegen precedent

The existing config-gated AI feature (BFL image generation) is the proven template; Studio mirrors it
piece for piece.

| Concern | imagegen precedent | Studio |
|---|---|---|
| Config fields + gate | `config.go:52-59` (`ImageGenEnabled`) | chat/tavily/fetch fields + `StudioEnabled()` |
| Session flag | `server.go:45-53` map | `"studioEnabled": cfg.StudioEnabled() && id.Authenticated` |
| Provider interface | `imagegen/model.go:63-65` | `studio.Provider` |
| Injection point | `server.go:19-37` (`build`/`NewWithProvider`) | thread `studio.Provider` through `build`, test constructor |
| Real-vs-fake select | `server.go:69-74` | `if provider == nil && cfg.StudioEnabled() { real }` |
| Handler auth+feature gate | `fanart_generate.go:39-46` | `!Authenticated → 403`; `nil provider → 404` |
| `.env.example` | `.env.example:21-25` | loom-name block, "leave empty to disable" |
| Fake provider test | `fanart_generate_test.go:16-27` | fake `studio.Provider` |
| Gate tests | `config_test.go:34-59` | key-off / key-on |

### 5.1 Config & env

Reuse **loom's exact env var names** so the owner can copy loom's `.env` verbatim:

- `BACKEND_CHAT_BASE_URL` / `BACKEND_CHAT_API_KEY` — MiMo, OpenAI-compatible `/chat/completions`; model
  hardcoded `mimo-v2.5-pro`, `reasoning_effort: high`.
- `BACKEND_TAVILY_URL` (default `https://mcp.tavily.com/mcp/`) / `BACKEND_TAVILY_API_KEY` — web search.
- `BACKEND_FETCH_MCP_URL` — web page fetch.

Gate: `StudioEnabled() = ChatAPIKey != "" && TavilyAPIKey != ""` (LLM **and** search both required; no
degraded/no-search mode).

### 5.2 Backend packages

- **`backend/internal/studio`** — `Provider` interface:
  `Generate(ctx, GenerateRequest) (GenerateResult, error)`, `Refine(ctx, RefineRequest) (string, error)`.
  DTOs: `GenerateRequest{ Reference }`, `GenerateResult{ StylePrompt, Lyrics, CoverArtPrompt }`,
  `RefineRequest{ Reference, Lyrics, Instruction }`. The real provider drives the research loop and
  prompt templates; the model's **final answer is strict JSON** (`{stylePrompt, lyrics, coverArtPrompt}`
  for generate, `{lyrics}` for refine) so parsing is deterministic.
- **`backend/internal/llm`** (minimal port, no obscura) — OpenAI-compatible client with tool-calling:
  `Tool`, `ToolCall`, `Message{role,content,tool_calls,tool_call_id}`, a `/chat/completions` executor
  with `Authorization: Bearer`. Non-streaming is sufficient (response message struct includes
  `tool_calls`).
- **`backend/internal/mcp`** (minimal port) — streamable-HTTP JSON-RPC `remoteClient` (`initialize`,
  `ListTools`, `CallTool`, SSE-or-JSON decode, `Mcp-Session-Id`); `ServerConfig`;
  `TavilyServerConfig(url,key)` (tool allowlist `tavily_search`, key as `?tavilyApiKey=` query param);
  `FetchServerConfig(url)` (tool `fetch`); a trimmed `Service` exposing `Tools() []llm.Tool` +
  `CallTool`. No stdio, categories, status, or obscura.
- **Research loop** (mirrors loom `assistant_loop.go` minimally): tools from `Service.Tools()`; loop up
  to `maxToolRounds` (6); each round call MiMo; if no `tool_calls` and text present → done; else append
  the assistant message and dispatch each `tools/call` (`tavily_search` / `fetch`, per-call 30s timeout,
  32KB output cap), appending `role:"tool"` results; after the round cap, force a tool-free final-answer
  turn that emits the JSON. Bounded overall by a request timeout.

### 5.3 HTTP handlers

- `POST /api/studio/generate {reference}` → `{stylePrompt, lyrics, coverArtPrompt}`
- `POST /api/studio/refine {reference, lyrics, instruction}` → `{lyrics}`

Both gate `!Authenticated → 403` and `provider == nil → 404`. **Synchronous** (ephemeral result
returned directly; frontend shows a loading state) with a bounded server timeout — unlike imagegen's
async/poll flow, since nothing is stored.

### 5.4 Frontend (`ui/`)

- **`src/Rail.tsx`** — convert the greyed Studio `<span>` (`Rail.tsx:109-113`) into a `<button>`
  mirroring `desktopItem` (active `match: r => r.name === "studio"`, `navigate("/studio")`), gated on
  `authenticated && studioEnabled`; add the mobile `tabItem`. Rail stays on the SVG `<Glyph name="spark">`
  (Phase 8 — the rail does not move to the font). New `studioEnabled` prop.
- **`src/router.ts`** — `| { name: "studio" }` on `Route`; `parsePath` branch for `/studio`.
- **`src/api.ts`** — `studioEnabled: boolean` on `Session`; `studioGenerate(reference)` and
  `studioRefine(reference, lyrics, instruction)` fetch clients (throw on `!r.ok`).
- **`src/App.tsx`** — `route.name === "studio"` branch rendering `<StudioPage>` gated on
  `authed && session?.studioEnabled`; pass `studioEnabled` to `<Rail>`; add `studioEnabled: false` to
  the anonymous-session fallback.
- **New `src/StudioPage.tsx`** — reference field + Generate; loading state; three result cards (Style
  with char count, Lyrics with the Refine row, Cover-art), each with a Copy button reusing `copyText`.
  loom CSS-var tokens, inline styles, English only, no AI wordmark, every `aria-label` preserved. Reset
  UX per §3.

## 6. Testing & verification

- **Backend** (`make test` / `cd backend && go test ./...` green):
  - Fake `studio.Provider` injected via a test constructor: `/api/studio/generate` returns the three
    fields; `/api/studio/refine` returns updated lyrics; `403` unauthenticated; `404` when provider nil.
  - `config_test.go`: `StudioEnabled()` false with no keys, false with one key, true with both.
  - Research loop against fake chat + tool transports (no live API): tool round → result appended →
    final JSON parsed; round cap forces the final answer.
- **Frontend** (`make fe-test`: tsc clean + vitest green):
  - `StudioPage.test.tsx` via `renderToStaticMarkup` — field + (given a stub result) three cards +
    Refine row.
  - Rail: Studio button present iff `authenticated && studioEnabled`.
- **Playwright e2e**: (1) anonymous → no rail slot, no `/studio`; (2) key-less authenticated → not
  shown; (3) authenticated + keys → visible, Generate yields three outputs with valid Suno tags and an
  epoch-correct cover-art prompt, Copy works, Refine changes only the lyrics, changing the reference +
  Enter resets and regenerates.
- **Pre-merge**: read-only code-review agent over the PR diff; address findings.
