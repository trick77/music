# music

Self-hosted, song-first music player: Go backend serving a JSON API + an embedded React SPA.

## Working conventions
- English only in docs/code/comments. TDD: failing test first, then minimal impl.
- One feature branch per phase (`feat/phase-N-...`); never commit to `master`. Conventional commits.
- Keep files focused — one responsibility each. `.yaml`, never `.yml`.
- No AI branding or wordmark in any UI copy.
- **Validate every runnable change with Playwright** (Playwright MCP browser tools) against the
  running app — real navigation/clicks/assertions, not only unit tests.
- **Every PR gets a generic code-review agent pass before merge**; address findings first. Never
  self-merge unreviewed. PRs target this repo's `master`, never an upstream.

## Locked technical choices
- Module `github.com/trick77/music`, Go 1.25, `CGO_ENABLED=0`.
- Pure-Go SQLite `ncruces/go-sqlite3` v0.23.3 (never `mattn/go-sqlite3`). One SQLite file.
- HTTP: stdlib `net/http` (Go 1.22 method routing), no framework.
- Frontend: Vite + React 19 + TS + Tailwind v4, built into `backend/web/dist` and embedded by Go.
- Design tokens = loom's `--*` CSS variables + self-hosted Anthropic fonts. Accent = clay #c6613f / #d97757.

## Commands
- `make test` / `make fe-test` — backend Go tests / frontend Vitest.
- `make fe-build` — build SPA into `backend/web/dist` (embedded by Go; do not commit built assets).
- `make build` — full single binary → `bin/music`. `make run` — local (needs `BACKEND_SESSION_SECRET`).
- `make docker-dev` — single-image stack on :8080 with dev autologin.

## Migrations
- Add `backend/internal/store/migrations/NNNN_*.sql`; runner applies pending ones in order. Never edit an applied migration.

## Security invariants
- Every write endpoint is gated to the authenticated role; anonymous can only read/play/download/share.
- Media/image file access is sandboxed under the configured roots — reject `..`, absolute paths, symlink escape.
- Secrets via env only; never commit them.
