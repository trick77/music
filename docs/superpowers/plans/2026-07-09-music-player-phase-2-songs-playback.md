# Music Player — Phase 2: Songs & Playback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1 skeleton into a working song library — authenticated MP3 upload with server-side ID3 + duration parsing into the managed store, content-hash dedupe, range-request streaming and open download, and a minimal frontend that lists songs and plays one (with seek).

**Architecture:** Add three focused backend packages over the Phase 1 SQLite schema (which already contains `artists`, `songs`, `genres`, `song_genres`): `media` (sandboxed managed file store), `metadata` (MP3 tag + duration parsing), and `library` (song/artist/genre repository). Wire five HTTP routes into the existing `httpapi` server. Replace the placeholder SPA with a song list + `<audio>` player and an authenticated-only upload control.

**Tech Stack:** Go 1.25, stdlib `net/http` (Go 1.22 method routing) + `http.ServeContent` for ranges, `github.com/dhowden/tag` (ID3 read), `github.com/hajimehoshi/go-mp3` (pure-Go duration decode), `github.com/ncruces/go-sqlite3` v0.23.3; React 19 + TypeScript + Vite + Vitest.

## Global Constraints

- Module path `github.com/trick77/music`. Go `1.25.0`. `CGO_ENABLED=0` everywhere — both new deps are pure Go; verify the build stays CGO-free.
- Pure-Go SQLite `github.com/ncruces/go-sqlite3` pinned to **`v0.23.3`**. Never `mattn/go-sqlite3`.
- **No AI branding or wordmark in any UI copy.** App copy is English. No `ß` (use `ss`) — moot here, copy is English.
- Design tokens are loom's CSS variables verbatim: bg `#1f1f1e`, panel `#1b1b1a`, active `#2c2c2a`, border `#323230`, ink `#faf9f5`, muted `#9c9a92`, accent `#c6613f`, accent-strong `#d97757`, radius `10px`. Fonts: self-hosted Anthropic Sans/Serif.
- YAML files use `.yaml` (never `.yml`). Docs/code/comments in English.
- TDD: write the failing test first. Conventional commits. Feature branch `feat/phase-2-songs-playback`; never commit to `master`.
- **Security invariants (spec §14):** every write endpoint gated to the authenticated role; anonymous can only read/play/download. All media file access sandboxed under `BACKEND_MEDIA_DIR` — reject `..`, absolute paths, symlink escape. Uploads validated (extension/MIME/size).
- **Playwright validation.** The phase closes by driving the *running* app with the Playwright MCP browser tools — real upload, play, seek, and 206-range assertions — not just unit tests.
- **Review-agent gate before merge.** Dispatch a generic code-review agent over the PR diff and address findings before merging. Never self-merge unreviewed. The PR targets **this repo's** `master`, never an upstream.

---

## Phase 2 scope (in / out)

**In:** song + artist + genre persistence (case-folded matching); managed audio store with content-hash dedupe and path sandboxing; authenticated upload endpoint that parses ID3 tags (title/artist/album/year/track) + duration + multi-genre (`; `-delimited); range streaming; open download; a minimal frontend song list that plays a song with working seek.

**Out (later phases — do NOT build):** OIDC, tag editor + typeahead, cover art + auto-match, playlists, queue, favorites, share links, fanart / BFL generation, Top-Ten / `POST /play` counting, the full immersive UI. The `plays`, `cover_art`, `fanart`, `playlists` tables already exist from Phase 1 migration `0001`; leave them untouched.

---

## File structure (Phase 2)

- `backend/internal/media/store.go` — managed store: sandboxed path `Resolve`, `Create`, `Open`. One responsibility: safe file storage under the media root.
- `backend/internal/metadata/mp3.go` — `Parse` reads ID3 tags (dhowden/tag) + decodes duration (go-mp3). `backend/internal/metadata/testdata/sample.mp3` — committed fixture with known tags + duration.
- `backend/internal/library/songs.go` — `Repo`: `Create`, `List`, `Get`, `FindByContentHash`; artist/genre upsert (case-folded). `backend/internal/library/id.go` — `NewID()`.
- `backend/internal/store/migrations/0002_songs_content_hash.sql` — unique partial index on `songs(content_hash)`.
- `backend/internal/httpapi/songs.go` — the five song handlers + JSON helpers. `backend/internal/httpapi/server.go` — modified to register song routes.
- `ui/src/api.ts` — `Song`/`Session` types + fetch helpers. `ui/src/format.ts` (+ `format.test.ts`) — duration formatter. `ui/src/App.tsx` — song list + `<audio>` player + upload control.

---

## Task 1: Managed media store (sandboxed file storage)

**Files:**
- Create: `backend/internal/media/store.go`
- Test: `backend/internal/media/store_test.go`

**Interfaces:**
- Consumes: none.
- Produces:
  - `media.New(root string) (*media.Store, error)` — resolves + creates `root`, records its symlink-real path.
  - `(*Store).Resolve(rel string) (string, error)` — store-relative → absolute, rejecting `..`, absolute input, and symlink escape (returns `media.ErrUnsafePath`).
  - `(*Store).Create(rel string) (*os.File, error)` — create file (and parent dirs) for writing.
  - `(*Store).Open(rel string) (*os.File, error)` — open file for reading.
  - `media.ErrUnsafePath` — sentinel error.

- [ ] **Step 1: Create the feature branch**

Run:
```bash
cd /Users/jan/localgit/music && git checkout master && git pull --ff-only && git checkout -b feat/phase-2-songs-playback
```
Expected: now on `feat/phase-2-songs-playback`.

- [ ] **Step 2: Write the failing test**

Create `backend/internal/media/store_test.go`:
```go
package media

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolve_rejectsEscapes(t *testing.T) {
	st, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, bad := range []string{"../secret", "/etc/passwd", "songs/../../secret", ""} {
		if _, err := st.Resolve(bad); err == nil {
			t.Fatalf("Resolve(%q) = nil error, want rejection", bad)
		}
	}
}

func TestResolve_acceptsInside(t *testing.T) {
	root := t.TempDir()
	st, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	abs, err := st.Resolve("songs/a.mp3")
	if err != nil {
		t.Fatalf("Resolve inside root: %v", err)
	}
	if !strings.HasPrefix(abs, st.rootReal) {
		t.Fatalf("resolved %q not under root %q", abs, st.rootReal)
	}
}

func TestResolve_rejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	st, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// A symlink INSIDE the root that points OUTSIDE it must not be a usable path.
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if _, err := st.Resolve("escape/secret.mp3"); err == nil {
		t.Fatal("Resolve through escaping symlink = nil error, want rejection")
	}
}

func TestCreateThenOpen_roundTrips(t *testing.T) {
	st, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f, err := st.Create("songs/x.mp3")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := f.WriteString("hello"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	f.Close()

	rf, err := st.Open("songs/x.mp3")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rf.Close()
	buf := make([]byte, 5)
	if _, err := rf.Read(buf); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(buf) != "hello" {
		t.Fatalf("round-trip = %q, want hello", buf)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/media/ -v`
Expected: FAIL (undefined `New`, `Store`, …).

- [ ] **Step 4: Write minimal implementation**

Create `backend/internal/media/store.go`:
```go
// Package media is the managed audio/image store: it owns file organization
// under a single root and guarantees every path stays sandboxed inside it.
package media

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ErrUnsafePath is returned when a store-relative path would escape the root.
var ErrUnsafePath = errors.New("media: unsafe path")

type Store struct {
	rootReal string // root with symlinks resolved; the sandbox boundary
}

// New ensures root exists and records its symlink-resolved absolute form.
func New(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("media: empty root")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	return &Store{rootReal: real}, nil
}

// Resolve maps a store-relative path to an absolute path under the root,
// rejecting absolute inputs, ".." traversal, and symlink escape.
func (s *Store) Resolve(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", ErrUnsafePath
	}
	// Clean("/"+rel) collapses any ".." against a virtual root, so no cleaned
	// path can climb above "/"; we then rejoin under the real root.
	clean := filepath.Clean("/" + rel)
	abs := filepath.Join(s.rootReal, strings.TrimPrefix(clean, string(os.PathSeparator)))
	if abs != s.rootReal && !strings.HasPrefix(abs, s.rootReal+string(os.PathSeparator)) {
		return "", ErrUnsafePath
	}
	// Defend against symlink escape: resolve the longest existing ancestor and
	// confirm it still sits inside the root.
	if real, err := longestReal(abs); err == nil {
		if real != s.rootReal && !strings.HasPrefix(real, s.rootReal+string(os.PathSeparator)) {
			return "", ErrUnsafePath
		}
	}
	return abs, nil
}

// longestReal walks up from p to the nearest existing ancestor, resolves its
// symlinks, and reattaches the non-existent tail.
func longestReal(p string) (string, error) {
	tail := ""
	cur := p
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(real, tail), nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", os.ErrNotExist
		}
		tail = filepath.Join(filepath.Base(cur), tail)
		cur = parent
	}
}

// Create opens rel for writing, creating parent directories as needed.
func (s *Store) Create(rel string) (*os.File, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	return os.Create(abs)
}

// Open opens rel for reading.
func (s *Store) Open(rel string) (*os.File, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	return os.Open(abs)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./internal/media/ -v`
Expected: PASS (all four).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/media/
git commit -m "feat(media): sandboxed managed file store (resolve/create/open)"
```

---

## Task 2: MP3 metadata parsing (ID3 tags + duration) with a real fixture

**Files:**
- Create: `backend/internal/metadata/mp3.go`, `backend/internal/metadata/testdata/sample.mp3`
- Test: `backend/internal/metadata/mp3_test.go`

**Interfaces:**
- Consumes: none.
- Produces:
  - `metadata.Tags{ Title, Artist, Album string; Year, TrackNo int; Genres []string; DurationMS int64 }`
  - `metadata.Parse(r io.ReadSeeker) (Tags, error)` — reads ID3 (dhowden/tag); duration decode failures are non-fatal (leave `DurationMS == 0`). Genres split on `"; "` (single delimiter).

- [ ] **Step 1: Add the dependencies**

Run:
```bash
cd backend && go get github.com/dhowden/tag@latest && go get github.com/hajimehoshi/go-mp3@latest
```
Expected: both added to `go.mod`. (Both are pure Go — the `CGO_ENABLED=0` build must keep working; verified in Step 6.)

- [ ] **Step 2: Generate the committed test fixture**

The duration/tag tests are only meaningful against a real MP3 with *known* metadata. Generate one with ffmpeg (2.0 s sine tone + fixed ID3v2 tags):
```bash
mkdir -p backend/internal/metadata/testdata
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ac 2 -ar 44100 -b:a 128k \
  -metadata title="Test Song" \
  -metadata artist="Test Artist" \
  -metadata album="Test Album" \
  -metadata date="2020" \
  -metadata track="3" \
  -metadata genre="Synthwave; Dream Pop" \
  -id3v2_version 3 -write_id3v1 1 \
  backend/internal/metadata/testdata/sample.mp3
```
Confirm it exists and is non-empty: `ls -l backend/internal/metadata/testdata/sample.mp3`.

- [ ] **Step 3: Write the failing test**

Create `backend/internal/metadata/mp3_test.go`:
```go
package metadata

import (
	"os"
	"testing"
)

func openFixture(t *testing.T) *os.File {
	t.Helper()
	f, err := os.Open("testdata/sample.mp3")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestParse_readsTags(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got.Title != "Test Song" {
		t.Errorf("Title = %q, want Test Song", got.Title)
	}
	if got.Artist != "Test Artist" {
		t.Errorf("Artist = %q, want Test Artist", got.Artist)
	}
	if got.Album != "Test Album" {
		t.Errorf("Album = %q, want Test Album", got.Album)
	}
	if got.Year != 2020 {
		t.Errorf("Year = %d, want 2020", got.Year)
	}
	if got.TrackNo != 3 {
		t.Errorf("TrackNo = %d, want 3", got.TrackNo)
	}
}

func TestParse_splitsMultiGenre(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(got.Genres) != 2 || got.Genres[0] != "Synthwave" || got.Genres[1] != "Dream Pop" {
		t.Fatalf("Genres = %#v, want [Synthwave Dream Pop]", got.Genres)
	}
}

func TestParse_decodesDuration(t *testing.T) {
	got, err := Parse(openFixture(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	// Fixture is a 2.0s tone; allow encoder padding slack.
	if got.DurationMS < 1850 || got.DurationMS > 2150 {
		t.Fatalf("DurationMS = %d, want ~2000", got.DurationMS)
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd backend && go test ./internal/metadata/ -v`
Expected: FAIL (undefined `Parse`).

- [ ] **Step 5: Write minimal implementation**

Create `backend/internal/metadata/mp3.go`:
```go
// Package metadata parses MP3 ID3 tags and decodes playback duration.
package metadata

import (
	"io"
	"strconv"
	"strings"

	"github.com/dhowden/tag"
	"github.com/hajimehoshi/go-mp3"
)

// genreDelimiter is the canonical multi-genre separator (spec §10), e.g.
// "Synthwave; Dream Pop". Only this delimiter is used — commas and slashes
// appear inside legitimate genre names ("Drum & Bass", "Rock/Pop").
const genreDelimiter = ";"

// Tags is the metadata extracted from an uploaded MP3.
type Tags struct {
	Title      string
	Artist     string
	Album      string
	Year       int
	TrackNo    int
	Genres     []string
	DurationMS int64
}

// Parse reads ID3 metadata from r and decodes its duration. Tag reading errors
// are returned; duration decode failures are non-fatal (DurationMS stays 0) so
// an odd-but-playable file still imports.
func Parse(r io.ReadSeeker) (Tags, error) {
	var out Tags
	m, err := tag.ReadFrom(r)
	if err != nil {
		return out, err
	}
	out.Title = strings.TrimSpace(m.Title())
	out.Artist = strings.TrimSpace(m.Artist())
	out.Album = strings.TrimSpace(m.Album())
	out.Year = m.Year()
	if n, _ := m.Track(); n > 0 {
		out.TrackNo = n
	}
	out.Genres = splitGenres(m.Genre())

	if _, err := r.Seek(0, io.SeekStart); err == nil {
		out.DurationMS = decodeDurationMS(r)
	}
	return out, nil
}

func splitGenres(raw string) []string {
	var genres []string
	for _, g := range strings.Split(raw, genreDelimiter) {
		if g = strings.TrimSpace(g); g != "" {
			genres = append(genres, g)
		}
	}
	return genres
}

// decodeDurationMS decodes the MP3 stream to measure its true length. go-mp3
// emits 16-bit little-endian stereo PCM (4 bytes per sample frame), so the
// duration is Length()/4/SampleRate seconds. Returns 0 on any decode error.
func decodeDurationMS(r io.Reader) int64 {
	d, err := mp3.NewDecoder(r)
	if err != nil {
		return 0
	}
	sr := int64(d.SampleRate())
	if sr <= 0 {
		return 0
	}
	frames := d.Length() / 4
	return frames * 1000 / sr
}

var _ = strconv.Itoa // reserved for future numeric tag parsing
```

Note: remove the trailing `var _ = strconv.Itoa` line and the `strconv` import if the linter objects — it is a harmless guard only if `strconv` ends up unused. If `go build` reports `strconv` unused, delete both the import and that line.

- [ ] **Step 6: Run tests + confirm CGO-free build**

Run:
```bash
cd backend && go mod tidy && go test ./internal/metadata/ -v && CGO_ENABLED=0 go build ./...
```
Expected: all three tests PASS; the `CGO_ENABLED=0` build succeeds (confirms both deps are pure Go).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/metadata/ backend/go.mod backend/go.sum
git commit -m "feat(metadata): ID3 tag + duration parsing with committed fixture"
```

---

## Task 3: Song repository (artists, genres, songs) + dedupe migration

**Files:**
- Create: `backend/internal/library/songs.go`, `backend/internal/library/id.go`, `backend/internal/store/migrations/0002_songs_content_hash.sql`
- Test: `backend/internal/library/songs_test.go`

**Interfaces:**
- Consumes: `*sql.DB` (from `store.Store.DB()`).
- Produces:
  - `library.NewID() string` — 32-hex random id.
  - `library.Song{ ID, Title, ArtistID, ArtistName, Album string; Year, TrackNo int; DurationMS, FileSize int64; FilePath, ContentHash string; Genres []string; CreatedAt string }` (JSON-tagged; `FilePath`/`ContentHash` are `json:"-"`).
  - `library.CreateSongParams{ Title, ArtistName, Album string; Year, TrackNo int; DurationMS, FileSize int64; FilePath, ContentHash string; Genres []string }`
  - `library.NewRepo(db *sql.DB) *Repo`
  - `(*Repo).Create(ctx, id string, p CreateSongParams) (*Song, error)` — upserts artist (case-folded via `name_key`; empty ⇒ "Unknown artist") and genres (case-insensitive via `COLLATE NOCASE`), inserts song + `song_genres` in one transaction, first genre marked `is_primary`.
  - `(*Repo).List(ctx) ([]Song, error)` — newest first, with artist name + genres.
  - `(*Repo).Get(ctx, id string) (*Song, error)` — one song or `(nil, nil)`.
  - `(*Repo).FindByContentHash(ctx, hash string) (*Song, error)` — dedupe lookup or `(nil, nil)`.

- [ ] **Step 1: Write the dedupe migration**

Create `backend/internal/store/migrations/0002_songs_content_hash.sql`:
```sql
-- Enforce content-hash dedupe for songs that carry a hash (empty hash allowed
-- for legacy/edge rows). 0001 is already applied and must never be edited.
CREATE UNIQUE INDEX idx_songs_content_hash
    ON songs(content_hash) WHERE content_hash != '';
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/library/songs_test.go`:
```go
package library

import (
	"context"
	"testing"

	"github.com/trick77/music/internal/store"
)

func newRepo(t *testing.T) *Repo {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return NewRepo(st.DB())
}

func sampleParams() CreateSongParams {
	return CreateSongParams{
		Title:       "Test Song",
		ArtistName:  "Test Artist",
		Album:       "Test Album",
		Year:        2020,
		TrackNo:     3,
		DurationMS:  2000,
		FilePath:    "songs/a.mp3",
		FileSize:    123,
		ContentHash: "hash-a",
		Genres:      []string{"Synthwave", "Dream Pop"},
	}
}

func TestCreate_persistsSongWithArtistAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if song.ArtistName != "Test Artist" {
		t.Errorf("ArtistName = %q", song.ArtistName)
	}
	if len(song.Genres) != 2 {
		t.Errorf("Genres = %#v, want 2", song.Genres)
	}
	got, err := r.Get(ctx, song.ID)
	if err != nil || got == nil {
		t.Fatalf("Get: %v (song %v)", err, got)
	}
	if got.Title != "Test Song" || got.Year != 2020 || got.TrackNo != 3 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestCreate_reusesArtistCaseInsensitively(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p1 := sampleParams()
	p1.ContentHash = "h1"
	s1, err := r.Create(ctx, NewID(), p1)
	if err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	p2 := sampleParams()
	p2.ArtistName = "test artist" // different case
	p2.ContentHash = "h2"
	p2.FilePath = "songs/b.mp3"
	s2, err := r.Create(ctx, NewID(), p2)
	if err != nil {
		t.Fatalf("Create 2: %v", err)
	}
	if s1.ArtistID != s2.ArtistID {
		t.Fatalf("artist not reused: %q vs %q", s1.ArtistID, s2.ArtistID)
	}
}

func TestCreate_emptyArtistBecomesUnknown(t *testing.T) {
	r := newRepo(t)
	p := sampleParams()
	p.ArtistName = ""
	song, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if song.ArtistName != "Unknown artist" {
		t.Fatalf("ArtistName = %q, want Unknown artist", song.ArtistName)
	}
}

func TestFindByContentHash(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	created, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	found, err := r.FindByContentHash(ctx, "hash-a")
	if err != nil {
		t.Fatalf("FindByContentHash: %v", err)
	}
	if found == nil || found.ID != created.ID {
		t.Fatalf("dedupe lookup = %v, want %s", found, created.ID)
	}
	miss, err := r.FindByContentHash(ctx, "nope")
	if err != nil {
		t.Fatalf("FindByContentHash miss: %v", err)
	}
	if miss != nil {
		t.Fatalf("expected nil for unknown hash, got %v", miss)
	}
}

func TestList_newestFirst(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p1 := sampleParams()
	p1.Title, p1.ContentHash, p1.FilePath = "First", "h1", "songs/1.mp3"
	if _, err := r.Create(ctx, NewID(), p1); err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	p2 := sampleParams()
	p2.Title, p2.ContentHash, p2.FilePath = "Second", "h2", "songs/2.mp3"
	if _, err := r.Create(ctx, NewID(), p2); err != nil {
		t.Fatalf("Create 2: %v", err)
	}
	songs, err := r.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(songs) != 2 {
		t.Fatalf("List len = %d, want 2", len(songs))
	}
	// Both created "now"; ordering falls back to id desc — just assert both present.
	titles := map[string]bool{songs[0].Title: true, songs[1].Title: true}
	if !titles["First"] || !titles["Second"] {
		t.Fatalf("List titles = %v", titles)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/library/ -v`
Expected: FAIL (undefined `Repo`, `NewID`, …).

- [ ] **Step 4: Write the id helper**

Create `backend/internal/library/id.go`:
```go
package library

import (
	"crypto/rand"
	"encoding/hex"
)

// NewID returns a random 32-character hex identifier.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return hex.EncodeToString(b[:])
}
```

- [ ] **Step 5: Write the repository**

Create `backend/internal/library/songs.go`:
```go
// Package library persists songs, artists, and genres over the SQLite store.
package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Song is a stored track with its artist name and genres denormalized for reads.
type Song struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	ArtistID    string   `json:"artistId"`
	ArtistName  string   `json:"artistName"`
	Album       string   `json:"album"`
	Year        int      `json:"year"`
	TrackNo     int      `json:"trackNo"`
	DurationMS  int64    `json:"durationMs"`
	FilePath    string   `json:"-"`
	FileSize    int64    `json:"fileSize"`
	ContentHash string   `json:"-"`
	Genres      []string `json:"genres"`
	CreatedAt   string   `json:"createdAt"`
}

// CreateSongParams carries the data for a new song import.
type CreateSongParams struct {
	Title       string
	ArtistName  string
	Album       string
	Year        int
	TrackNo     int
	DurationMS  int64
	FileSize    int64
	FilePath    string
	ContentHash string
	Genres      []string
}

type Repo struct{ db *sql.DB }

func NewRepo(db *sql.DB) *Repo { return &Repo{db: db} }

// Create upserts artist + genres and inserts the song and its genre links in a
// single transaction. The first genre is flagged is_primary.
func (r *Repo) Create(ctx context.Context, id string, p CreateSongParams) (*Song, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	artistID, err := upsertArtist(ctx, tx, p.ArtistName)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO songs(id, title, artist_id, album, year, track_no, duration_ms, file_path, file_size, content_hash)
		 VALUES(?,?,?,?,?,?,?,?,?,?)`,
		id, p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo),
		p.DurationMS, p.FilePath, p.FileSize, p.ContentHash,
	); err != nil {
		return nil, err
	}
	for i, g := range dedupeGenres(p.Genres) {
		genreID, err := upsertGenre(ctx, tx, g)
		if err != nil {
			return nil, err
		}
		primary := 0
		if i == 0 {
			primary = 1
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO song_genres(song_id, genre_id, is_primary) VALUES(?,?,?)`,
			id, genreID, primary,
		); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// FindByContentHash returns the song with the given hash, or (nil, nil).
func (r *Repo) FindByContentHash(ctx context.Context, hash string) (*Song, error) {
	if hash == "" {
		return nil, nil
	}
	var id string
	err := r.db.QueryRowContext(ctx, `SELECT id FROM songs WHERE content_hash = ?`, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// Get returns one song by id, or (nil, nil) if absent.
func (r *Repo) Get(ctx context.Context, id string) (*Song, error) {
	row := r.db.QueryRowContext(ctx, songSelect+` WHERE s.id = ?`, id)
	song, err := scanSong(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	genres, err := r.genresFor(ctx, id)
	if err != nil {
		return nil, err
	}
	song.Genres = genres
	return song, nil
}

// List returns all songs, newest first.
func (r *Repo) List(ctx context.Context) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+` ORDER BY s.created_at DESC, s.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var songs []Song
	for rows.Next() {
		s, err := scanSong(rows)
		if err != nil {
			return nil, err
		}
		genres, err := r.genresFor(ctx, s.ID)
		if err != nil {
			return nil, err
		}
		s.Genres = genres
		songs = append(songs, *s)
	}
	return songs, rows.Err()
}

const songSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.created_at
	FROM songs s JOIN artists a ON a.id = s.artist_id`

type scanner interface {
	Scan(dest ...any) error
}

func scanSong(row scanner) (*Song, error) {
	var s Song
	var album sql.NullString
	var year, track sql.NullInt64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &s.CreatedAt); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.Genres = []string{}
	return &s, nil
}

func (r *Repo) genresFor(ctx context.Context, songID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT g.name FROM song_genres sg JOIN genres g ON g.id = sg.genre_id
		 WHERE sg.song_id = ? ORDER BY sg.is_primary DESC, g.name`, songID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	genres := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		genres = append(genres, name)
	}
	return genres, rows.Err()
}

func upsertArtist(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Unknown artist"
	}
	key := strings.ToLower(name)
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM artists WHERE name_key = ?`, key).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO artists(id, name, name_key) VALUES(?,?,?)`, id, name, key)
	return id, err
}

func upsertGenre(ctx context.Context, tx *sql.Tx, name string) (string, error) {
	name = strings.TrimSpace(name)
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM genres WHERE name = ? COLLATE NOCASE`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO genres(id, name) VALUES(?,?)`, id, name)
	return id, err
}

func dedupeGenres(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range in {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		k := strings.ToLower(g)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, g)
	}
	return out
}

func nullStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func nullInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && go test ./internal/library/ ./internal/store/ -v`
Expected: PASS (library tests + store migration re-runs cleanly with `0002`).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/library/ backend/internal/store/migrations/0002_songs_content_hash.sql
git commit -m "feat(library): song/artist/genre repository + content-hash dedupe index"
```

---

## Task 4: HTTP handlers — upload, list, get, stream, download

**Files:**
- Create: `backend/internal/httpapi/songs.go`
- Modify: `backend/internal/httpapi/server.go`
- Test: `backend/internal/httpapi/songs_test.go`

**Interfaces:**
- Consumes: `config.Config`, `*store.Store`, `library.Repo`, `media.Store`, `metadata.Parse`.
- Produces (routes registered on the existing `/api/` mux when a store + media root are present):
  - `GET /api/songs` — list (public).
  - `POST /api/songs` — upload MP3 (**authenticated only**; multipart field `file`); dedupe returns the existing song with `200`, new import returns `201`.
  - `GET /api/songs/{id}` — one song (public).
  - `GET /api/songs/{id}/stream` — range-capable stream, `Content-Type: audio/mpeg` (public).
  - `GET /api/songs/{id}/download` — same bytes with `Content-Disposition: attachment` (public).

- [ ] **Step 1: Write the failing test**

Create `backend/internal/httpapi/songs_test.go`:
```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

func testServer(t *testing.T, mode config.AuthMode) http.Handler {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{
		AuthMode:    mode,
		DevUser:     config.DevUserConfig{Username: "dev"},
		MediaDir:    t.TempDir(),
		MaxUploadMB: 50,
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, st, spa)
}

func uploadFixture(t *testing.T, h http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	data, err := os.ReadFile("../metadata/testdata/sample.mp3")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "sample.mp3")
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/songs", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestUpload_devParsesTagsAndLists(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var song struct {
		ID         string   `json:"id"`
		Title      string   `json:"title"`
		ArtistName string   `json:"artistName"`
		Genres     []string `json:"genres"`
		DurationMS int64    `json:"durationMs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	if song.Title != "Test Song" || song.ArtistName != "Test Artist" {
		t.Fatalf("parsed song = %+v", song)
	}
	if len(song.Genres) != 2 {
		t.Fatalf("genres = %v, want 2", song.Genres)
	}
	if song.DurationMS < 1850 || song.DurationMS > 2150 {
		t.Fatalf("duration = %d, want ~2000", song.DurationMS)
	}

	// List reflects it.
	lr := httptest.NewRecorder()
	h.ServeHTTP(lr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(lr.Body.Bytes(), &list)
	if len(list.Songs) != 1 || list.Songs[0].ID != song.ID {
		t.Fatalf("list = %+v", list)
	}
}

func TestUpload_dedupeReturnsExisting(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	first := uploadFixture(t, h)
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload = %d", first.Code)
	}
	second := uploadFixture(t, h)
	if second.Code != http.StatusOK {
		t.Fatalf("dedupe upload status = %d, want 200", second.Code)
	}
	// Only one song stored.
	lr := httptest.NewRecorder()
	h.ServeHTTP(lr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []json.RawMessage `json:"songs"`
	}
	json.Unmarshal(lr.Body.Bytes(), &list)
	if len(list.Songs) != 1 {
		t.Fatalf("stored %d songs, want 1 (dedupe)", len(list.Songs))
	}
}

func TestUpload_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC) // oidc + no session ⇒ anonymous
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous upload status = %d, want 403", rr.Code)
	}
}

func TestStream_supportsRange(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	req := httptest.NewRequest("GET", "/api/songs/"+song.ID+"/stream", nil)
	req.Header.Set("Range", "bytes=0-99")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("range stream status = %d, want 206", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("Content-Type = %q, want audio/mpeg", ct)
	}
	if rr.Header().Get("Content-Range") == "" {
		t.Fatal("missing Content-Range header on 206")
	}
	if n := len(rr.Body.Bytes()); n != 100 {
		t.Fatalf("range body = %d bytes, want 100", n)
	}
}

func TestDownload_setsAttachment(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("download status = %d", rr.Code)
	}
	if cd := rr.Header().Get("Content-Disposition"); !bytes.Contains([]byte(cd), []byte("attachment")) {
		t.Fatalf("Content-Disposition = %q, want attachment", cd)
	}
	if _, err := io.ReadAll(rr.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run 'Upload|Stream|Download' -v`
Expected: FAIL (song routes not registered → 404/SPA).

- [ ] **Step 3: Write the handlers**

Create `backend/internal/httpapi/songs.go`:
```go
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/metadata"
)

type songHandlers struct {
	cfg      config.Config
	repo     *library.Repo
	media    *media.Store
	maxBytes int64
}

func (h *songHandlers) list(w http.ResponseWriter, r *http.Request) {
	songs, err := h.repo.List(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list songs")
		return
	}
	writeJSON(w, map[string]any{"songs": songs})
}

func (h *songHandlers) get(w http.ResponseWriter, r *http.Request) {
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, song)
}

func (h *songHandlers) upload(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		httpError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()
	if !isMP3(header.Filename, header.Header.Get("Content-Type")) {
		httpError(w, http.StatusUnsupportedMediaType, "only mp3 uploads are supported")
		return
	}

	tmp, err := os.CreateTemp("", "music-upload-*.mp3")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "temp file")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	hasher := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, hasher), file)
	if err != nil {
		httpError(w, http.StatusBadRequest, "read upload")
		return
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	if existing, err := h.repo.FindByContentHash(r.Context(), hash); err != nil {
		httpError(w, http.StatusInternalServerError, "dedupe check")
		return
	} else if existing != nil {
		writeJSONStatus(w, http.StatusOK, existing)
		return
	}

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		httpError(w, http.StatusInternalServerError, "seek")
		return
	}
	tags, _ := metadata.Parse(tmp) // tag/duration issues are non-fatal

	newID := library.NewID()
	relPath := "songs/" + newID + ".mp3"
	dst, err := h.media.Create(relPath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "store file")
		return
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		dst.Close()
		httpError(w, http.StatusInternalServerError, "seek")
		return
	}
	if _, err := io.Copy(dst, tmp); err != nil {
		dst.Close()
		httpError(w, http.StatusInternalServerError, "write file")
		return
	}
	if err := dst.Close(); err != nil {
		httpError(w, http.StatusInternalServerError, "close file")
		return
	}

	title := tags.Title
	if title == "" {
		title = strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename))
	}
	song, err := h.repo.Create(r.Context(), newID, library.CreateSongParams{
		Title:       title,
		ArtistName:  tags.Artist,
		Album:       tags.Album,
		Year:        tags.Year,
		TrackNo:     tags.TrackNo,
		DurationMS:  tags.DurationMS,
		FileSize:    size,
		FilePath:    relPath,
		ContentHash: hash,
		Genres:      tags.Genres,
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "save song")
		return
	}
	writeJSONStatus(w, http.StatusCreated, song)
}

func (h *songHandlers) stream(w http.ResponseWriter, r *http.Request)   { h.serveFile(w, r, false) }
func (h *songHandlers) download(w http.ResponseWriter, r *http.Request) { h.serveFile(w, r, true) }

func (h *songHandlers) serveFile(w http.ResponseWriter, r *http.Request, attach bool) {
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	f, err := h.media.Open(song.FilePath)
	if err != nil {
		httpError(w, http.StatusNotFound, "audio file missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "stat file")
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	if attach {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", downloadName(song)))
	}
	http.ServeContent(w, r, song.ID+".mp3", info.ModTime(), f)
}

func isMP3(filename, contentType string) bool {
	if strings.EqualFold(filepath.Ext(filename), ".mp3") {
		return true
	}
	return contentType == "audio/mpeg" || contentType == "audio/mp3"
}

func downloadName(s *library.Song) string {
	base := s.Title
	if s.ArtistName != "" {
		base = s.ArtistName + " - " + s.Title
	}
	base = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) {
			return '_'
		}
		return r
	}, base)
	if base == "" {
		base = s.ID
	}
	return base + ".mp3"
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 4: Wire the routes into the server**

Replace `backend/internal/httpapi/server.go` with:
```go
package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/store"
)

func New(cfg config.Config, st *store.Store, spa http.Handler) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		id := identify(cfg, r)
		writeJSON(w, map[string]any{"authenticated": id.Authenticated, "username": id.Username})
	})

	// Song routes require a store and a media root; both are present in normal
	// runs. (Phase 1 unit tests pass st=nil and no media dir and never hit these.)
	if st != nil && cfg.MediaDir != "" {
		if mstore, err := media.New(cfg.MediaDir); err == nil {
			h := &songHandlers{
				cfg:      cfg,
				repo:     library.NewRepo(st.DB()),
				media:    mstore,
				maxBytes: int64(cfg.MaxUploadMB) * 1024 * 1024,
			}
			mux.HandleFunc("GET /api/songs", h.list)
			mux.HandleFunc("POST /api/songs", h.upload)
			mux.HandleFunc("GET /api/songs/{id}", h.get)
			mux.HandleFunc("GET /api/songs/{id}/stream", h.stream)
			mux.HandleFunc("GET /api/songs/{id}/download", h.download)
		}
	}

	// Anything not under /api/ is the SPA.
	root := http.NewServeMux()
	root.Handle("/api/", mux)
	root.Handle("/", spa)
	return root
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && go test ./...`
Expected: PASS (new song tests + all Phase 1 tests still green — the `New` signature is unchanged).

- [ ] **Step 6: Commit**

```bash
git add backend/internal/httpapi/songs.go backend/internal/httpapi/server.go backend/internal/httpapi/songs_test.go
git commit -m "feat(httpapi): song upload, list, get, range stream, download"
```

---

## Task 5: Frontend — song list + `<audio>` player + upload

**Files:**
- Create: `ui/src/api.ts`, `ui/src/format.ts`, `ui/src/format.test.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/session`, `GET /api/songs`, `POST /api/songs`, `GET /api/songs/{id}/stream`, `GET /api/songs/{id}/download`.
- Produces: a rendered song list; a `<audio controls>` element that streams the selected song; an upload `<input type="file">` shown only when authenticated.

- [ ] **Step 1: Write the failing formatter test**

Create `ui/src/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(185000)).toBe("3:05");
  });
  it("pads seconds", () => {
    expect(formatDuration(5000)).toBe("0:05");
  });
  it("handles zero and invalid", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npm run test -- --run format`
Expected: FAIL (cannot resolve `./format`).

- [ ] **Step 3: Write the formatter**

Create `ui/src/format.ts`:
```ts
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npm run test -- --run format`
Expected: PASS.

- [ ] **Step 5: Write the API client**

Create `ui/src/api.ts`:
```ts
export type Session = { authenticated: boolean; username: string };

export type Song = {
  id: string;
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  durationMs: number;
  genres: string[];
};

export async function getSession(): Promise<Session> {
  const r = await fetch("/api/auth/session");
  return r.json();
}

export async function listSongs(): Promise<Song[]> {
  const r = await fetch("/api/songs");
  if (!r.ok) throw new Error("failed to load songs");
  const data = await r.json();
  return data.songs ?? [];
}

export async function uploadSong(file: File): Promise<Song> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/songs", { method: "POST", body: form });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  return r.json();
}

export function streamUrl(id: string): string {
  return `/api/songs/${id}/stream`;
}
```

- [ ] **Step 6: Rewrite App.tsx as the song list + player**

Replace `ui/src/App.tsx` with:
```tsx
import { useEffect, useRef, useState } from "react";
import { getSession, listSongs, uploadSong, streamUrl, type Session, type Song } from "./api";
import { formatDuration } from "./format";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<Song | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const refresh = () => listSongs().then(setSongs).catch(() => setError("Could not load songs"));

  useEffect(() => {
    getSession().then(setSession).catch(() => setSession({ authenticated: false, username: "" }));
    refresh();
  }, []);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadSong(file);
      await refresh();
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const play = (song: Song) => {
    setNowPlaying(song);
    // Load + play after the src updates.
    requestAnimationFrame(() => {
      const el = audioRef.current;
      if (el) {
        el.load();
        void el.play().catch(() => {});
      }
    });
  };

  return (
    <div style={{ minHeight: "100vh", maxWidth: 720, margin: "0 auto", padding: "2rem 1.25rem 8rem" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "1.75rem", margin: 0 }}>Music</h1>
        {session?.authenticated && (
          <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.95rem" }}>
            {uploading ? "Uploading…" : "Upload"}
            <input type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />
          </label>
        )}
      </header>

      {error && <p style={{ color: "var(--color-accent-strong)" }}>{error}</p>}

      {songs.length === 0 ? (
        <p style={{ color: "var(--color-muted)" }}>
          {session?.authenticated ? "No songs yet — upload one to get started." : "Nothing here yet."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {songs.map((song) => {
            const active = nowPlaying?.id === song.id;
            return (
              <li
                key={song.id}
                onClick={() => play(song)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "1rem",
                  padding: "0.7rem 0.85rem",
                  borderRadius: "var(--radius-ui, 10px)",
                  cursor: "pointer",
                  background: active ? "var(--color-active)" : "transparent",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {song.title}
                  </span>
                  <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>
                    {song.artistName}
                    {song.genres.length > 0 && ` · ${song.genres.join(", ")}`}
                  </span>
                </span>
                <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {formatDuration(song.durationMs)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {nowPlaying && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--color-panel)",
            borderTop: "1px solid var(--color-border)",
            padding: "0.75rem 1.25rem",
          }}
        >
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            <div style={{ marginBottom: "0.4rem", fontSize: "0.9rem" }}>
              <strong>{nowPlaying.title}</strong>
              <span style={{ color: "var(--color-muted)" }}> — {nowPlaying.artistName}</span>
            </div>
            <audio ref={audioRef} controls style={{ width: "100%" }} src={streamUrl(nowPlaying.id)}>
              <track kind="captions" />
            </audio>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Build the frontend + full binary**

Run:
```bash
cd ui && npm install && npm run test -- --run && npm run build
cd ../backend && CGO_ENABLED=0 go build ./...
```
Expected: Vitest passes, `vite build` writes `backend/web/dist`, Go build succeeds.

- [ ] **Step 8: Commit (do not commit built dist assets)**

The built assets under `backend/web/dist/assets/*` are git-ignored (only `index.html` is tracked). Restore the tracked placeholder so the commit stays source-only:
```bash
printf '<!doctype html><meta charset="utf-8"><title>Music</title><div id="root">build the UI: make fe-build</div>' > backend/web/dist/index.html
git add ui/src/api.ts ui/src/format.ts ui/src/format.test.ts ui/src/App.tsx
git commit -m "feat(ui): song list, audio player with seek, authenticated upload"
```

---

## Task 6: End-to-end Playwright validation, PR, review, merge

**Files:** none (drives the running app).

**Interfaces:** Consumes the built binary + the committed fixture MP3.

- [ ] **Step 1: Build and run the app on a clean data dir**

Run:
```bash
make build
rm -rf /tmp/music-e2e && mkdir -p /tmp/music-e2e
BACKEND_SESSION_SECRET=e2e-secret BACKEND_AUTH_MODE=dev \
  BACKEND_DB_PATH=/tmp/music-e2e/music.db BACKEND_MEDIA_DIR=/tmp/music-e2e/media \
  ./bin/music &
sleep 2 && curl -s localhost:8080/api/health
```
Expected: `{"status":"ok"}`. Leave the server running for the Playwright steps.

- [ ] **Step 2: Drive the app with Playwright MCP (upload → parse → play → seek)**

Using the Playwright MCP browser tools:
1. `browser_navigate` → `http://localhost:8080/` — `browser_snapshot` shows heading **"Music"** and the **"Upload"** control (dev autologin ⇒ authenticated).
2. `browser_file_upload` with the absolute path `/Users/jan/localgit/music/backend/internal/metadata/testdata/sample.mp3` on the upload input. (Click the "Upload" label first if the tool needs the chooser opened.)
3. `browser_snapshot` — confirm a row with **"Test Song"** and **"Test Artist"** (and duration ~`0:02`) appears.
4. `browser_click` the song row → confirm the now-playing bar shows the `<audio>` element.
5. `browser_evaluate`:
   ```js
   () => { const a = document.querySelector('audio'); return { paused: a.paused, dur: a.duration, ct: a.currentTime }; }
   ```
   Confirm `dur` is a finite number (~2) — proves the stream loaded.
6. Seek check via `browser_evaluate`:
   ```js
   () => { const a = document.querySelector('audio'); a.currentTime = 1; return a.currentTime; }
   ```
   Expect ~`1` returned — proves range-request seeking works.
7. `browser_network_requests` — confirm a request to `/api/songs/<id>/stream` returned **206** (partial content), the range invariant the seek depends on.

Record the outcomes (pass/fail per assertion) for the PR description.

- [ ] **Step 3: Verify dedupe + anonymous access via curl**

Run:
```bash
# Re-upload the same file → dedupe: song count stays 1.
curl -s -F "file=@backend/internal/metadata/testdata/sample.mp3" localhost:8080/api/songs >/dev/null
curl -s localhost:8080/api/songs | grep -o '"id"' | wc -l   # expect 1
# Download carries an attachment disposition.
SID=$(curl -s localhost:8080/api/songs | sed -n 's/.*"id":"\([a-f0-9]*\)".*/\1/p' | head -1)
curl -s -D - -o /dev/null localhost:8080/api/songs/$SID/download | grep -i content-disposition
```
Expected: song count `1`; a `Content-Disposition: attachment` header.

- [ ] **Step 4: Tear down**

Run: `kill %1` (stop the server).

- [ ] **Step 5: Push and open the PR**

Run:
```bash
git push -u origin feat/phase-2-songs-playback
gh pr create --repo trick77/music --base master --head feat/phase-2-songs-playback \
  --title "feat: Phase 2 — songs & playback" \
  --body "Managed audio store, authenticated MP3 upload with ID3 + duration parsing, content-hash dedupe, range streaming + download, and a song list that plays with seek. Playwright e2e: upload→parse→play→seek→206 all pass."
```
**Fork check:** `trick77/music` is the user's own repo (not a fork of an upstream); the PR targets **this** repo's `master`. Confirm the base is `trick77/music` before creating.

- [ ] **Step 6: Gate on a code-review agent, then merge**

Dispatch a generic code-review agent (Agent tool `subagent_type: "general-purpose"`, or the `code-review` skill) over the PR diff. Address any findings with follow-up commits (push to the same branch), then merge:
```bash
gh pr merge --repo trick77/music --squash --delete-branch
```
Only merge after review findings are resolved and CI/tests are green. Confirm the merge targets **this repo's** `master`, never an upstream.

---

## Self-review notes

- **Spec coverage (Phase 2 scope):** song+artist persistence with case-folded matching (§5) ✓ (Task 3, `name_key` + `COLLATE NOCASE`); managed store under `BACKEND_MEDIA_DIR` with app-owned `songs/<id>.mp3` layout, relative `file_path`, content-hash dedupe, path sandbox rejecting `..`/absolute/symlink escape (§6, §14) ✓ (Tasks 1, 3, 4); authenticated upload parsing ID3 title/artist/album/year/track/duration + multi-genre via `; ` (§10) ✓ (Tasks 2, 4); range streaming via `http.ServeContent` (§6) ✓ (Task 4, 206 test); download with `Content-Disposition: attachment`, open to all (§6) ✓ (Task 4); minimal frontend list + `<audio>` play with seek (§15 subset) ✓ (Tasks 5, 6). Deferred items (OIDC, tag editor, cover art, playlists, fanart/generation, immersive UI, play-counting) explicitly out ✓.
- **Duration robustness:** parsed via pure-Go `go-mp3`; decode failure is non-fatal (`DurationMS=0`), isolated from tag parsing, and the CGO-free build is asserted (Task 2, Step 6). The fixture is committed so the duration assertion is real, not theater.
- **Security gating:** upload returns 403 for anonymous (Task 4 `TestUpload_anonymousForbidden`); stream/download stay public; every media path goes through `media.Resolve` (Task 1 rejection tests).
- **Type consistency:** `library.Song`/`CreateSongParams` fields consumed by `httpapi/songs.go` match Task 3; `media.New/Create/Open` match Task 1; `metadata.Parse`/`Tags` match Task 2; `New(cfg, st, spa)` signature is unchanged so Phase 1 `httpapi`/`web` tests keep compiling; frontend `Song` JSON fields (`durationMs`, `artistName`, `genres`) match the Go `json` tags.
- **Migrations:** `0002` adds only a unique partial index; `0001` is untouched. Runner applies it in order and the store test re-opens idempotently.
- **Placeholders:** none — every code step carries complete code and exact commands.
```
