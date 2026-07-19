# Music player webapp — design spec

**Status:** approved — ready for implementation planning · **Date:** 2026-07-09 · **Visual reference:**
[`docs/mockups/music-player-mockup.html`](../../mockups/music-player-mockup.html)
(open in a browser; also published as a claude.ai artifact during design).

---

## 1. Context & goal

A self-hosted web music player for the maintainer's own catalogue of music. The library is
**song-first**: tracks are uploaded individually, not as albums. The app must look and feel like
[`../loom`](../../../loom) — the **Warm Editorial dark** system (warm-charcoal surfaces, off-white
ink, clay accent) with the self-hosted Anthropic Sans/Serif variable fonts — and be **image-forward
and immersive**: large photographic imagery carries the home and every collection page.

The UI carries **no branding of any kind** — no wordmark, and nothing that references how the music
was made. It reads as a normal, personal music player.

Two access states, nothing in between:

- **Anonymous** — browse, search, play any song/playlist, download, and share. Read-only.
- **Authenticated** (via Authentik at `auth.trick77.com`) — everything above **plus** upload songs,
  edit MP3 tags, upload/assign cover art and fanart, and create/edit playlists. No admin/user
  split; **logged in = full access**.

Login-only controls are communicated by **presence vs absence** — an anonymous visitor simply does
not see them. **No lock icons, no disabled states, no "sign in to…" prompts** anywhere.

**Favorites (the heart) are for everyone.** Hearting a song is client-side only — stored in the
browser's **localStorage**, available to anonymous and authenticated visitors alike. There is no
"Save" button and no server-side likes table; the heart icon is the entire feature. **Caveat:**
localStorage is per-device/per-browser, so favorites don't sync across devices — accepted for v1;
if cross-device sync is wanted later, only the authenticated owner's favorites would move
server-side.

## 2. Non-goals (explicitly deferred — do NOT build in v1)

- **Suno.ai integration** — a later phase.
- **A logged-in "creation"/Studio tool** — Suno-prompt-style lyric/prompt generation from known
  songs via MiMo 2.5 Pro. The rail reserves a greyed "Studio — soon" slot; the feature itself is out
  of scope.
- Multiple audio qualities/transcoding — there is **one** quality: the original uploaded file.
- Social features beyond a shareable public link (no comments, follows, accounts-for-others).

## 3. Tech stack (mirror loom)

Mirror loom's locked choices; ship as a **single Docker image** (Go binary serves the embedded SPA).

- **Backend:** Go (stdlib `net/http`, Go 1.22 method routing), `CGO_ENABLED=0`.
- **DB:** one **pure-Go SQLite** file via `ncruces/go-sqlite3` (same pin as loom, `v0.23.3`). No
  separate DB service. Numbered migrations under `backend/internal/store/migrations/NNNN_*.sql`,
  applied in order and recorded in `schema_migrations`; never edit an applied migration.
- **Frontend:** Vite + React 19 + TypeScript + Tailwind v4, built into `backend/web/dist` and
  embedded in the Go binary. Design tokens are the loom `--*` CSS variables; reuse the themed
  Tailwind utilities and the self-hosted Anthropic fonts verbatim.
- **Config:** all runtime config via `BACKEND_*` env vars (see §12); secrets via env only.
- **Repo conventions:** English docs/code/comments; feature branch per phase, conventional commits,
  never commit to `master`; TDD (failing test first); `.yaml` not `.yml`. Add an `AGENTS.md`
  (loom-style) at implementation time — this repo will have `AGENTS.md`, not `CLAUDE.md`.

## 4. Authentication (mirror loom's OIDC, with local autologin)

Reuse loom's auth model directly (`backend/internal/auth`, `BACKEND_AUTH_MODE`):

- **Prod — `BACKEND_AUTH_MODE=oidc`:** OpenID Connect Authorization-Code flow against Authentik
  (`coreos/go-oidc` + `golang.org/x/oauth2`). Callback at `/api/auth/callback`; state + nonce
  cookies; a signed session cookie (`BACKEND_SESSION_SECRET`) after success. Post-logout redirect
  configurable. Config keys as in loom: `BACKEND_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`,
  `_REDIRECT_URL`, `_POST_LOGOUT_REDIRECT_URL`. The maintainer adds a "music" application in
  Authentik, configured like the loom application.
- **Local — `BACKEND_AUTH_MODE=dev`:** **autologin.** A fixed `DevUser` (loom's
  `BACKEND_DEV_USER_USERNAME`, default `dev`) is treated as an authenticated, full-access identity
  with **no login round-trip**, so every signed-in feature is exercisable locally without Authentik.

**Authorization scope — decided: group-gated, just like loom.** Membership in a configured
Authentik group (`BACKEND_OIDC_ALLOWED_GROUP`, mirroring loom's `BACKEND_OIDC_ADMIN_GROUP` gating)
grants the **authenticated / full-access** role. A user who authenticates but is **not** in the
group is treated as **read-only** (identical to anonymous). This reuses loom's OIDC group-claim
handling directly.

**Session model:** a single role bit — `authenticated` vs `anonymous`. No per-user data isolation is
required (one owner); all content is a single shared library. (This is the one place music
*simplifies* loom's per-user scoping.)

## 5. Data model (SQLite)

Song-first, with album as an optional tag and genres many-to-many.

- **`artists`** — `id`, `name` (unique, case-folded key for matching).
- **`songs`** — `id`, `title`, `artist_id`, `album` (nullable text tag), `year` (nullable),
  `track_no` (nullable), `duration_ms`, `file_path` (managed-store relative path), `file_size`,
  `content_hash` (dedupe), `cover_art_id` (nullable), `created_at`.
- **`genres`** — `id`, `name` (unique).
- **`song_genres`** — (`song_id`, `genre_id`) join; a song has **0..n** genres and appears under
  each. Optional `is_primary` flag marks the one genre shown in single-genre slots.
- **`playlists`** — `id`, `name`, `description` (nullable), `cover_art_id` (nullable), `created_at`.
- **`playlist_songs`** — (`playlist_id`, `song_id`, `position`).
- **`cover_art`** — `id`, `image_path`, `width`, `height`, `content_hash`. Referenced by songs
  (per artist+album, see §7) and playlists.
- **`fanart`** — `id`, `image_path`, `kind` (`hero` | `genre`), `genre_id` (nullable, for
  `kind=genre`), `caption` (nullable), `sort` — the admin-managed photographic imagery (§8).
- **`plays`** — `id`, `song_id`, `played_at`. One row per qualified play (§9). Top-Ten reads an
  aggregate; keep raw rows for future windowing (e.g. "this month").

All timestamps UTC. Add sensible indexes: `songs(artist_id)`, `song_genres(genre_id)`,
`plays(song_id)`, `plays(played_at)`.

## 6. Audio storage, streaming & download

- **Managed store.** Uploads are copied into the app's own volume layout (e.g.
  `<BACKEND_MEDIA_DIR>/songs/<id>.mp3`); the DB keeps metadata + the relative `file_path`. The app
  owns file organization. `content_hash` prevents duplicate imports.
- **One quality** — the original uploaded MP3, unmodified.
- **Streaming:** `GET /api/songs/{id}/stream` serves the file with **HTTP range-request** support
  (`Accept-Ranges: bytes`, `206 Partial Content`) so the `<audio>` element can seek. Use
  `http.ServeContent` (handles range + conditional requests) against the opened file.
- **Download:** `GET /api/songs/{id}/download` serves the same bytes with
  `Content-Disposition: attachment`. Open to everyone.
- **Sandboxing:** every media path is resolved under the media root; reject `..`, absolute paths,
  and symlink escape (loom's file-access invariant).

## 7. Cover-art auto-matching (artist + album)

When an authenticated user sets cover art (in the tag editor, or during upload) for a song that has
an `album` tag, the artwork is associated with the **(artist, album)** pair and **automatically
applies to every existing and future song** sharing that artist+album. Songs with no album tag
(standalone singles) get per-song artwork instead. Songs with neither show the **"no cover art"**
fallback tile (disc glyph + initial) shown in the mockup.

## 8. Imagery / fanart (admin uploads & assigns)

Photographic imagery is a **first-class** element, managed by authenticated users:

- Upload images and **assign** them: as **genre art** (one or more per genre) or as **featured hero**
  picks. Stored on the volume like cover art (`fanart` table, §5).
- **Multiple images per genre.** A genre keeps a small **gallery** (`fanart` rows,
  `kind=genre`, `genre_id`), each image either uploaded or generated. One is marked the **active
  background**; one may be **starred** as the featured Home hero. A per-genre accent color is
  auto-sampled from the active background.
- **Genre background editor** (authenticated): from a genre page, an "Edit" action opens a modal
  with a large preview, the image gallery (pick background / star for hero / Upload tile), the
  generate panel (below), and the genre's name.

### 8a. AI image generation (mirror loom's `imagegen`/BFL)

Authenticated users can **generate** a genre image (or Home-hero image) from a **text prompt**,
reusing loom's approach verbatim:

- **Engine:** Black Forest Labs (**BFL / FLUX**) — port loom's `backend/internal/imagegen`
  (`bfl.go`): async submit `{prompt, width, height, safety_tolerance, output_format, seed?}` to
  `{BASE_URL}/{model}` with an `x-key` header → receive `{id, polling_url}` → poll until
  `ready`/`completed` → download `result.sample`. Handles `request moderated` / `content moderated`
  gracefully. Optional `input_image` (base64) enables regenerating a variation of an existing image.
- **Config (loom-identical):** `BACKEND_BFL_BASE_URL` (`https://api.bfl.ai/v1`),
  `BACKEND_BFL_API_KEY`, `BACKEND_BFL_MODEL` (`flux-2-klein-4b`), `BACKEND_BFL_POLL_TIMEOUT`
  (`1m`). Generation is available only when `BACKEND_BFL_API_KEY` is set; otherwise the editor shows
  only Upload.
- **Flow & storage:** the app requests a **landscape** image sized for the hero/background, stores
  the returned bytes on the volume as a new `fanart` row (recording the prompt + model + seed for
  reference), and adds it to the genre's gallery in a "generating…" state until it resolves.
- **No-AI-in-UI holds:** the prompt box is an **owner-only, authenticated** tool. Anonymous
  visitors never see prompts, "generate", or any AI reference — only the finished imagery presented
  as ordinary art.
- Endpoint: `POST /api/fanart/generate` (authenticated) `{prompt, kind, genre_id?}` → returns the
  new `fanart` id; the client polls `GET /api/fanart/{id}` for readiness.
- Anonymous visitors see the imagery but cannot change it.
- Because remote images can't load in the preview, the mockup fakes fanart with atmospheric CSS
  (bloom + vignette + grain); the **treatment** (moody, cinematic, heavy scrim under text) is what
  real photography inherits. Every image needs a graceful **no-image fallback**.

**Placement — build the proposal, validate with real images.** The mockup's direction (full-bleed
featured hero on Home + genres returning lower as immersive "chapters"; a full-immersion detail
template where art owns the top two-thirds over a glass song-list panel) is the **build starting
point**. The maintainer can't judge final placement from CSS stand-ins — so once BFL generation is
wired up and real photographic images exist, placement is the **first thing to tune in the running
app**. Keep the layout componentized so hero/chapter/detail arrangements can shift without a rewrite.

## 9. Play counting & Top Ten

- A **play** is recorded once a track has been listened to for **~30 seconds** (avoids
  skip-inflation), counted **globally across all visitors, including anonymous**.
- The client reports the qualifying event to `POST /api/songs/{id}/play`; the server appends a
  `plays` row. (Guard against trivial replay/refresh abuse with light per-session throttling.)
- **Top Ten** = the ten songs with the most plays. The raw `plays` rows allow future time-windowed
  charts ("this month") without a schema change.

## 10. Upload & MP3 tag editor (authenticated)

- **Upload** (modal from the rail's Upload action): drop MP3s; read ID3 tags (title/artist/album/
  year/track/genre) server-side; multi-value genre parsed from a delimited tag (e.g.
  `Synthwave; Dream Pop`) into `song_genres`. Per-file progress; cover-art auto-match note when a
  file joins an existing artist+album (§7). Files with no tags are flagged "needs editing".
- **Tag editor** (modal): edit title/artist/album/album-artist/year/track/comment; **Genres is a
  multi-chip field** (add/remove); **Replace cover** writes artwork to the whole artist+album (§7).
  Saving **writes back to the file's ID3 tags** and updates the DB. Album and track-no. are optional.
- Use a maintained Go ID3 library for read+write (select at implementation; must handle ID3v2 +
  embedded APIC cover frames).
- **Typeahead** on the **Artist**, **Album**, and **Genre** fields (in both upload and the tag
  editor): as the user types, suggest existing values from the library (with a usage count) plus a
  "use as new …" row. Keeps naming consistent and avoids duplicate artist/album/genre spellings.
  Backed by `GET /api/suggest?field=artist|album|genre&q=` (§12).

## 10a. Playlist create / edit (authenticated)

Opened from the sidebar "+", the "New playlist" card, or a playlist's Edit action. A modal with an
**optional cover** (upload; falls back to a tile derived from the songs), **name**, optional
**description**, and the **song list** — reorder by drag handle, remove per-row, and **add songs**
via a search/typeahead row. Anonymous visitors can play any playlist but never see the edit
affordances.

## 11. Sharing

Every song, playlist, and collection page has a **Share** action (hero, detail page, full-screen
player). It yields a **public URL** to that resource — playable by anonymous visitors (the whole
catalogue is already publicly playable), so sharing needs no tokens or per-link auth in v1. Share is
**open to everyone**, not gated.

## 12. HTTP API surface (sketch)

Public (anonymous OK): `GET /api/songs`, `/api/songs/{id}`, `/api/songs/{id}/stream`,
`/api/songs/{id}/download`, `POST /api/songs/{id}/play`, `GET /api/genres`, `/api/genres/{id}`,
`GET /api/playlists`, `/api/playlists/{id}`, `GET /api/top-ten`, `GET /api/home` (hero + sections),
`GET /api/search?q=`, `GET /api/cover/{id}`, `GET /api/fanart/{id}`.

Authenticated only: `POST /api/songs` (upload), `PATCH /api/songs/{id}` (tags),
`PUT /api/songs/{id}/cover` (+ artist+album propagation), `POST/PATCH/DELETE /api/playlists…`
(incl. reorder), `PATCH /api/genres/{id}` (name/background), `POST /api/fanart` + assign,
`GET /api/suggest?field=artist|album|genre&q=` (typeahead). Auth endpoints: `/api/auth/login`,
`/api/auth/callback`, `/api/auth/logout`, `GET /api/auth/session`. **No likes endpoint** —
favorites are localStorage-only (§1).

## 13. Config (env, `BACKEND_*`)

`BACKEND_SESSION_SECRET` (required), `BACKEND_AUTH_MODE` (`oidc`|`dev`),
`BACKEND_OIDC_ISSUER/_CLIENT_ID/_CLIENT_SECRET/_REDIRECT_URL/_POST_LOGOUT_REDIRECT_URL`,
`BACKEND_OIDC_ALLOWED_GROUP` (optional), `BACKEND_DEV_USER_USERNAME` (dev),
`BACKEND_DB_PATH`, `BACKEND_MEDIA_DIR`, `BACKEND_MAX_UPLOAD_MB`. Image generation (optional, §8a):
`BACKEND_BFL_BASE_URL`, `BACKEND_BFL_API_KEY`, `BACKEND_BFL_MODEL`, `BACKEND_BFL_POLL_TIMEOUT`.

Ship a committed **`.env.example`** at the repo root that the maintainer copies to `.env` (and a
`compose.dev.yaml` for local, like loom). It must carry every var with safe placeholders and inline
comments. Concretely:

```dotenv
# --- Core (required) ---
BACKEND_SESSION_SECRET=change-me-to-a-long-random-string
BACKEND_DB_PATH=/data/music.db
BACKEND_MEDIA_DIR=/data/media
BACKEND_MAX_UPLOAD_MB=50

# --- Auth ---
# Local development: dev = autologin as a fixed full-access user, no Authentik needed.
BACKEND_AUTH_MODE=dev
BACKEND_DEV_USER_USERNAME=dev
# Production: set BACKEND_AUTH_MODE=oidc and fill these (Authentik "music" application).
BACKEND_OIDC_ISSUER=https://auth.trick77.com/application/o/music/
BACKEND_OIDC_CLIENT_ID=
BACKEND_OIDC_CLIENT_SECRET=
BACKEND_OIDC_REDIRECT_URL=https://music.trick77.com/api/auth/callback
BACKEND_OIDC_POST_LOGOUT_REDIRECT_URL=https://music.trick77.com/
# Optional: restrict the authenticated role to one Authentik group (unset = any valid login).
BACKEND_OIDC_ALLOWED_GROUP=

# --- Image generation (optional; leave API key empty to disable the Generate button) ---
BACKEND_BFL_BASE_URL=https://api.bfl.ai/v1
BACKEND_BFL_API_KEY=
BACKEND_BFL_MODEL=flux-2-klein-4b
BACKEND_BFL_POLL_TIMEOUT=1m
```

For a working **local** setup the maintainer only needs `BACKEND_SESSION_SECRET` (any long string) —
`BACKEND_AUTH_MODE=dev` autologins, and image generation stays off until a BFL key is added.

## 14. Security invariants (must hold)

- Every write endpoint is role-gated to `authenticated`; anonymous sessions can only read/play/
  download/share.
- All media/image file access is sandboxed under the configured roots — reject `..`, absolute
  paths, symlink escape.
- Secrets via env only; never committed. Uploads validated (MIME/extension/size).

## 15. Frontend screens (all in the mockup)

Home (immersive hero + Top-Ten ranked chart + Recently-added songs + genre chapters + playlists),
genre/artist/playlist **detail** (one template), **mobile** home (tab bar + docked mini-player),
**full-screen player**, **upload**, **tag editor** (with typeahead), **genre background editor**,
and **playlist create/edit**. Rank numbers use Anthropic **Sans** (tabular-nums), not serif. Slim
**icon-only** rail, no wordmark. The heart (favorite) appears on song rows, the now-playing bar and
the player — available to everyone, no "Save" button.

Also specified in the mockup: **Library** (segmented All songs / Favorites / Playlists — Favorites
is the home for hearted songs), **Search** (grouped results: top result, songs, artists, genres,
playlists), **empty / first-run** state (a single "Upload music" CTA signed in; a quiet "nothing
here yet" anonymous), and the **queue** (up-next, drag-reorder) + per-song **"…" context menu**
(play next, add to queue, add to playlist, go to artist/genre, download, share, and — signed-in only
— edit tags / delete) + **add-to-playlist** chooser.

## 15a. Additional v1 behaviour (spec-only, no separate mockup)

- **Mobile media controls:** implement the **MediaSession API** (metadata + play/pause/next/prev)
  so lock-screen / notification controls and background audio work on mobile. Register a service
  worker for basic installability (PWA); real offline caching is out of scope.
- **Image sizing:** generate sized variants (thumbnail / card / hero) for cover art and fanart —
  reuse loom's `backend/internal/imagescale` package — so pages don't load full-res everywhere.
- **Resume playback:** persist the current track + position (client-side, anonymous localStorage) and
  restore on reload. Removed 2026-07-16 (empty player on reload); re-added 2026-07-19 in a deliberately
  narrower form — the snapshot is written only when the page hides *while actually playing* (pagehide /
  visibilitychange→hidden), and restore reseeds the docked mini-player **paused** at the saved position,
  no time window and no autoplay. A reload while paused/stopped still comes up clean. Restore is gated to
  non-`/song/:id` routes so it can't collide with deep-link cueing or the resync effect.
- **Shared-link previews:** emit Open Graph / Twitter meta (title, artist, cover/fanart image) on
  song/playlist/genre routes so shared links render with art in chat apps.
- **Destructive actions:** delete song / playlist / genre-image require a confirm step.
- **Unknown metadata:** songs with no artist tag group under "Unknown artist"; missing album/genre
  render as "—" (as in the Library mockup).
- **Deferred (not v1):** bulk tag edit, crossfade/gapless, keyboard shortcuts, download-as-zip,
  extending the generator to per-song cover art (same BFL flow, square aspect).

## 16. Verification (implementation phase)

- Backend Go tests (`go test ./...`), frontend Vitest, per loom's `make` targets.
- End-to-end: boot with `BACKEND_AUTH_MODE=dev`, upload an MP3, confirm tags parsed + multi-genre,
  play >30s and see the Top-Ten count increment, set cover art and confirm it propagates across the
  artist+album, share a link and open it in an anonymous session, exercise range requests (seek) and
  download. Then boot with `oidc` against a test Authentik app and confirm the full login flow.

---

## Resolved decisions

1. **Auth scope** (§4) — group-gated, just like loom: a configured Authentik group grants full
   access; non-members are read-only.
2. **Imagery placement** (§8) — build the mockup's direction as the starting point; tune it against
   real generated images in the running app (can't be judged from CSS stand-ins).
