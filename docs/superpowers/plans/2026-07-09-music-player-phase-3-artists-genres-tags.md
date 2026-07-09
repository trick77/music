# Music Player — Phase 3: Artists, Genres & Tags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add metadata editing over the Phase 2 library — a tag editor that writes ID3 tags **back to the managed file** and updates the DB, artist/album/genre typeahead, artist & genre browse endpoints, and artist+album cover-art with auto-match that applies to **existing and future** songs sharing that artist+album.

**Architecture:** Extend the existing packages. `metadata` gains crash-safe ID3 write-back (`bogem/id3v2` `Save()` — temp-file+rename, verified in source). A new `album_covers(artist_id, album_key)→cover_art_id` mapping table (migration `0003`) is the durable source of cover auto-match, consulted by the upload path (future songs), the tag editor (album change), and the set-cover endpoint. A small `imageutil` package validates cover images. New HTTP routes: `PATCH /api/songs/{id}`, `GET /api/suggest`, `PUT /api/songs/{id}/cover`, `GET /api/cover/{id}`, `GET /api/artists`, `/api/artists/{id}`, `GET /api/genres`, `/api/genres/{id}`. The frontend gains a tag-editor modal (typeahead + cover replace) and cover thumbnails.

**Tech Stack:** Go 1.25, stdlib `net/http`, `github.com/bogem/id3v2/v2` (ID3 **write**), `github.com/dhowden/tag` (read), `github.com/hajimehoshi/go-mp3` (duration), stdlib `image` (dimensions); React 19 + TypeScript + Vite + Vitest.

## Global Constraints

- Module `github.com/trick77/music`. Go `1.25.0`. `CGO_ENABLED=0` everywhere — `bogem/id3v2` and stdlib `image` are pure Go; verify the build stays CGO-free.
- Pure-Go SQLite `github.com/ncruces/go-sqlite3` v0.23.3. Never `mattn/go-sqlite3`.
- **No AI branding or wordmark in any UI copy.** English copy. No `ß`.
- Design tokens are loom's CSS variables verbatim (bg `#1f1f1e`, panel `#1b1b1a`, active `#2c2c2a`, border `#323230`, ink `#faf9f5`, muted `#9c9a92`, accent `#c6613f`, accent-strong `#d97757`, radius `10px`). Fonts: self-hosted Anthropic Sans/Serif.
- YAML `.yaml` (never `.yml`). Docs/code/comments in English.
- TDD: failing test first. Conventional commits. Feature branch `feat/phase-3-artists-genres-tags`; never commit to `master`.
- **Security invariants (spec §14):** every write endpoint gated to the authenticated role (`PATCH /api/songs/{id}`, `PUT /api/songs/{id}/cover`, `GET /api/suggest` — suggest is authenticated per §12); anonymous can read/play/download/**view cover** only. All media/cover file access sandboxed under `BACKEND_MEDIA_DIR` (`..`/absolute/symlink rejected). Uploads validated (MIME/extension/size).
- **The managed audio file is the user's only copy** — ID3 write-back must be crash-safe (temp-file + atomic rename) and must **preserve** pre-existing frames (mutate the parsed tag; never build a fresh one).
- **Playwright validation** closes the phase — and must prove tag edits hit the **on-disk file** (re-parse the downloaded bytes), not just the API JSON; cover auto-match must be shown adopting on a **sibling** song and a **future upload**.
- **Review-agent gate before merge.** Dispatch a generic code-review agent over the PR diff, address findings, then merge into **this repo's** `master` (never an upstream).

---

## Phase 3 scope (in / out)

**In:** ID3 write-back; `PATCH /api/songs/{id}` (edit title/artist/album/year/track/genres); `GET /api/suggest?field=artist|album|genre&q=` (case-insensitive, usage counts); artist/genre browse endpoints; `PUT /api/songs/{id}/cover` with artist+album auto-match (existing **and** future songs) via `album_covers`; `GET /api/cover/{id}` (public) + no-cover fallback on the client; a tag-editor modal with typeahead and cover replace, and cover thumbnails on song rows.

**Out (later phases — do NOT build):** fanart, AI/BFL generation, genre background editor, image scaling variants (`imagescale`, §15a) — **Phase 5**; playlists/queue/favorites/share — **Phase 4**; the full immersive artist/genre/home pages, MediaSession/PWA — **Phase 6**; OIDC — **Phase 7**. Also deferred *within_ this phase: **album-artist** and **comment** fields shown in the mockup (not in the §5 data model) — the write-back **preserves** any such existing frames but does not add editing for them; play-counting/Top-Ten.

---

## File structure (Phase 3)

- `backend/internal/metadata/write.go` — `WriteTags(path, WriteableTags)` via `bogem/id3v2`. Test: `write_test.go`.
- `backend/internal/store/migrations/0003_album_covers.sql` — the album→cover mapping table.
- `backend/internal/library/covers.go` — `CreateCover`, `SetSongCover`, `albumCoverID`; `songs.go` gains `CoverArtID` + `Update` + browse methods (`ListArtists`, `GetArtist`, `ListGenres`, `GetGenre`, `Suggest`). Tests extend `songs_test.go`, add `covers_test.go`.
- `backend/internal/imageutil/imageutil.go` — `Probe(r)` → width/height/ext, rejects non-image. Test: `imageutil_test.go`.
- `backend/internal/httpapi/tags.go` — `PATCH /api/songs/{id}`, `GET /api/suggest`. `backend/internal/httpapi/covers.go` — `PUT /api/songs/{id}/cover`, `GET /api/cover/{id}`. `backend/internal/httpapi/browse.go` — artists/genres. `server.go` registers them. Tests: `tags_test.go`, `covers_test.go`, `browse_test.go`.
- `ui/src/api.ts` — new types + calls. `ui/src/TagEditor.tsx` — modal. `ui/src/App.tsx` — cover thumbnails + edit affordance. `ui/src/cover.ts` (+ test) — cover-url / fallback-initial helpers.

---

## Task 1: Crash-safe ID3 write-back

**Files:**
- Create: `backend/internal/metadata/write.go`
- Test: `backend/internal/metadata/write_test.go`

**Interfaces:**
- Consumes: the committed fixture `testdata/sample.mp3`; `metadata.Parse`.
- Produces:
  - `metadata.WriteableTags{ Title, Artist, Album string; Year, TrackNo int; Genres []string }`
  - `metadata.WriteTags(path string, t WriteableTags) error` — opens the file, mutates its parsed ID3v2 tag, and `Save()`s (temp-file + atomic rename; preserves audio + untouched frames). Genres are joined with `"; "`.

- [ ] **Step 1: Ensure the dependency is present**

Run:
```bash
cd backend && go get github.com/bogem/id3v2/v2@v2.1.4
```
Expected: `go.mod` requires `github.com/bogem/id3v2/v2 v2.1.4`.

- [ ] **Step 2: Write the failing test**

Create `backend/internal/metadata/write_test.go`:
```go
package metadata

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

// copyFixture copies the committed sample into a temp file we can safely mutate.
func copyFixture(t *testing.T) string {
	t.Helper()
	src, err := os.Open("testdata/sample.mp3")
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer src.Close()
	dst := filepath.Join(t.TempDir(), "edit.mp3")
	df, err := os.Create(dst)
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	if _, err := io.Copy(df, src); err != nil {
		t.Fatalf("copy: %v", err)
	}
	df.Close()
	return dst
}

func parsePath(t *testing.T, path string) Tags {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()
	tags, err := Parse(f)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return tags
}

func TestWriteTags_writesToFileAndPreservesAudio(t *testing.T) {
	path := copyFixture(t)
	before := parsePath(t, path)

	err := WriteTags(path, WriteableTags{
		Title:   "Edited Title",
		Artist:  "Edited Artist",
		Album:   "Edited Album",
		Year:    1999,
		TrackNo: 7,
		Genres:  []string{"Ambient", "Drone"},
	})
	if err != nil {
		t.Fatalf("WriteTags: %v", err)
	}

	after := parsePath(t, path)
	if after.Title != "Edited Title" || after.Artist != "Edited Artist" || after.Album != "Edited Album" {
		t.Fatalf("tags not written: %+v", after)
	}
	if after.Year != 1999 || after.TrackNo != 7 {
		t.Fatalf("year/track not written: %+v", after)
	}
	if len(after.Genres) != 2 || after.Genres[0] != "Ambient" || after.Genres[1] != "Drone" {
		t.Fatalf("genres not written: %#v", after.Genres)
	}
	// Audio must survive the rewrite: duration unchanged (go-mp3 re-decode).
	if before.DurationMS < 1850 || after.DurationMS < before.DurationMS-50 || after.DurationMS > before.DurationMS+50 {
		t.Fatalf("duration changed by rewrite: before=%d after=%d", before.DurationMS, after.DurationMS)
	}
}

func TestWriteTags_preservesUnsetFieldsIndependence(t *testing.T) {
	// Editing only the title must not blank the artist (mutate parsed tag).
	path := copyFixture(t)
	if err := WriteTags(path, WriteableTags{
		Title:  "Only Title Changed",
		Artist: "Test Artist",
		Album:  "Test Album",
		Year:   2020,
		Genres: []string{"Synthwave", "Dream Pop"},
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}
	after := parsePath(t, path)
	if after.Artist != "Test Artist" || after.Album != "Test Album" {
		t.Fatalf("unrelated fields lost: %+v", after)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/metadata/ -run TestWriteTags -v`
Expected: FAIL (undefined `WriteTags`).

- [ ] **Step 4: Write the implementation**

Create `backend/internal/metadata/write.go`:
```go
package metadata

import (
	"strconv"
	"strings"

	id3v2 "github.com/bogem/id3v2/v2"
)

// WriteableTags is the editable ID3 metadata written back to a file.
type WriteableTags struct {
	Title   string
	Artist  string
	Album   string
	Year    int
	TrackNo int
	Genres  []string
}

// WriteTags opens the MP3 at path, mutates its existing ID3v2 tag in place, and
// saves it. bogem/id3v2 Save() writes to a sibling temp file and atomically
// renames it over the original, so a crash cannot corrupt the only audio copy;
// mutating the *parsed* tag preserves frames we don't touch (e.g. album-artist,
// comment, cover art).
func WriteTags(path string, t WriteableTags) error {
	tag, err := id3v2.Open(path, id3v2.Options{Parse: true})
	if err != nil {
		return err
	}
	defer tag.Close()

	tag.SetTitle(t.Title)
	tag.SetArtist(t.Artist)
	if strings.TrimSpace(t.Album) != "" {
		tag.SetAlbum(t.Album)
	} else {
		tag.DeleteFrames(tag.CommonID("Album/Movie/Show title"))
	}
	if t.Year > 0 {
		tag.SetYear(strconv.Itoa(t.Year))
	} else {
		tag.DeleteFrames(tag.CommonID("Year"))
	}
	trackID := tag.CommonID("Track number/Position in set")
	if t.TrackNo > 0 {
		tag.AddTextFrame(trackID, tag.DefaultEncoding(), strconv.Itoa(t.TrackNo))
	} else {
		tag.DeleteFrames(trackID)
	}
	tag.SetGenre(strings.Join(t.Genres, "; "))

	return tag.Save()
}
```

- [ ] **Step 5: Run tests + confirm CGO-free build**

Run:
```bash
cd backend && go mod tidy && go test ./internal/metadata/ -v && CGO_ENABLED=0 go build ./...
```
Expected: all metadata tests PASS; CGO-free build succeeds.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/metadata/write.go backend/internal/metadata/write_test.go backend/go.mod backend/go.sum
git commit -m "feat(metadata): crash-safe ID3 tag write-back (bogem/id3v2)"
```

---

## Task 2: Album-cover mapping + repository cover/edit/browse support

**Files:**
- Create: `backend/internal/store/migrations/0003_album_covers.sql`, `backend/internal/library/covers.go`
- Modify: `backend/internal/library/songs.go` (add `CoverArtID` to `Song` + `songSelect`/`scanSong`; make `Create` consult the album mapping)
- Test: `backend/internal/library/covers_test.go`

**Interfaces:**
- Consumes: `*sql.DB`, `library.NewID`.
- Produces:
  - `Song.CoverArtID string` (`json:"coverArtId"`, empty when none).
  - `CoverParams{ ImagePath string; Width, Height int; ContentHash string }`; `(*Repo).CreateCover(ctx, CoverParams) (string, error)` — dedupes by `ContentHash` (returns existing id + its path is reused by the caller).
  - `(*Repo).FindCoverByHash(ctx, hash string) (id, imagePath string, err error)` — `("","",nil)` if none.
  - `(*Repo).SetSongCover(ctx, songID, coverID string) error` — if the song has an album, upsert `album_covers(artist_id, lower(album)) = coverID` and set `cover_art_id` on **all** songs of that artist+album; else set only this song.
  - `(*Repo).GetCoverPath(ctx, coverID string) (string, error)` — image_path or `sql.ErrNoRows`.
  - `Create` now sets a new song's `cover_art_id` from any existing `album_covers` row for its (artist, album) — so **future** uploads inherit the album cover.

- [ ] **Step 1: Write the migration**

Create `backend/internal/store/migrations/0003_album_covers.sql`:
```sql
-- Durable artist+album -> cover mapping so cover art auto-applies to every
-- existing AND future song sharing that artist+album (spec §7). Singles (no
-- album) use per-song songs.cover_art_id instead. 0001/0002 stay untouched.
CREATE TABLE album_covers (
    artist_id    TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    album_key    TEXT NOT NULL,                 -- lower(album)
    cover_art_id TEXT NOT NULL REFERENCES cover_art(id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, album_key)
);
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/library/covers_test.go`:
```go
package library

import (
	"context"
	"testing"
)

func makeSong(t *testing.T, r *Repo, title, album, hash, path string) *Song {
	t.Helper()
	p := sampleParams()
	p.Title, p.Album, p.ContentHash, p.FilePath = title, album, hash, path
	s, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("Create %s: %v", title, err)
	}
	return s
}

func makeCover(t *testing.T, r *Repo, hash string) string {
	t.Helper()
	id, err := r.CreateCover(context.Background(), CoverParams{
		ImagePath: "covers/" + hash + ".jpg", Width: 500, Height: 500, ContentHash: hash,
	})
	if err != nil {
		t.Fatalf("CreateCover: %v", err)
	}
	return id
}

func TestSetSongCover_propagatesAcrossArtistAlbum(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	b := makeSong(t, r, "B", "Album One", "h2", "songs/b.mp3")
	other := makeSong(t, r, "C", "Other Album", "h3", "songs/c.mp3")
	cover := makeCover(t, r, "covhash")

	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}

	// Both songs of Album One adopt it; the other album does not.
	for _, id := range []string{a.ID, b.ID} {
		got, _ := r.Get(ctx, id)
		if got.CoverArtID != cover {
			t.Fatalf("song %s cover = %q, want %q", id, got.CoverArtID, cover)
		}
	}
	if got, _ := r.Get(ctx, other.ID); got.CoverArtID != "" {
		t.Fatalf("other album wrongly covered: %q", got.CoverArtID)
	}
}

func TestCreate_futureSongInheritsAlbumCover(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Shared", "h1", "songs/a.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}
	// A song uploaded AFTER the cover was set must inherit it.
	future := makeSong(t, r, "Future", "Shared", "h9", "songs/future.mp3")
	if future.CoverArtID != cover {
		t.Fatalf("future song cover = %q, want %q", future.CoverArtID, cover)
	}
}

func TestSetSongCover_singleIsPerSong(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p := sampleParams()
	p.Album, p.ContentHash, p.FilePath = "", "h1", "songs/a.mp3" // no album
	single, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, single.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}
	got, _ := r.Get(ctx, single.ID)
	if got.CoverArtID != cover {
		t.Fatalf("single cover = %q, want %q", got.CoverArtID, cover)
	}
}

func TestCreateCover_dedupesByHash(t *testing.T) {
	r := newRepo(t)
	id1 := makeCover(t, r, "same")
	id2 := makeCover(t, r, "same")
	if id1 != id2 {
		t.Fatalf("expected dedupe, got %q and %q", id1, id2)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/library/ -run 'Cover|futureSong' -v`
Expected: FAIL (undefined `CreateCover`, `SetSongCover`, `CoverParams`, `Song.CoverArtID`).

- [ ] **Step 4: Add `CoverArtID` to the Song read path**

In `backend/internal/library/songs.go`:

Add the field to `Song` (after `ContentHash`):
```go
	ContentHash string   `json:"-"`
	CoverArtID  string   `json:"coverArtId"`
	Genres      []string `json:"genres"`
```

Change `songSelect` to select the cover id (LEFT-safe: it's a column on `songs`):
```go
const songSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.created_at
	FROM songs s JOIN artists a ON a.id = s.artist_id`
```

Change `scanSong` to read it via a `NullString`:
```go
func scanSong(row scanner) (*Song, error) {
	var s Song
	var album, cover sql.NullString
	var year, track sql.NullInt64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &s.CreatedAt); err != nil {
		return nil, err
	}
	s.Album = album.String
	s.Year = int(year.Int64)
	s.TrackNo = int(track.Int64)
	s.CoverArtID = cover.String
	s.Genres = []string{}
	return &s, nil
}
```

- [ ] **Step 5: Make `Create` inherit the album cover**

In `songs.go`, inside `Create`, replace the song `INSERT` block so the new song adopts any existing album cover. Find:
```go
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
```
Replace with:
```go
	artistID, err := upsertArtist(ctx, tx, p.ArtistName)
	if err != nil {
		return nil, err
	}
	coverID, err := albumCoverIDTx(ctx, tx, artistID, p.Album)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO songs(id, title, artist_id, album, year, track_no, duration_ms, file_path, file_size, content_hash, cover_art_id)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		id, p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo),
		p.DurationMS, p.FilePath, p.FileSize, p.ContentHash, nullStr(coverID),
	); err != nil {
		return nil, err
	}
```

- [ ] **Step 6: Write the covers repository**

Create `backend/internal/library/covers.go`:
```go
package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// CoverParams describes a stored cover image.
type CoverParams struct {
	ImagePath   string
	Width       int
	Height      int
	ContentHash string
}

// CreateCover inserts a cover_art row, deduping by content hash: if an image
// with the same bytes already exists, its id is returned and no row is added.
func (r *Repo) CreateCover(ctx context.Context, p CoverParams) (string, error) {
	if existingID, _, err := r.FindCoverByHash(ctx, p.ContentHash); err != nil {
		return "", err
	} else if existingID != "" {
		return existingID, nil
	}
	id := NewID()
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO cover_art(id, image_path, width, height, content_hash) VALUES(?,?,?,?,?)`,
		id, p.ImagePath, p.Width, p.Height, p.ContentHash)
	if err != nil {
		return "", err
	}
	return id, nil
}

// FindCoverByHash returns the id and image_path of a cover with the given hash,
// or ("","",nil) if none exists.
func (r *Repo) FindCoverByHash(ctx context.Context, hash string) (string, string, error) {
	if hash == "" {
		return "", "", nil
	}
	var id, path string
	err := r.db.QueryRowContext(ctx,
		`SELECT id, image_path FROM cover_art WHERE content_hash = ?`, hash).Scan(&id, &path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return id, path, nil
}

// GetCoverPath returns the stored image path for a cover id.
func (r *Repo) GetCoverPath(ctx context.Context, coverID string) (string, error) {
	var path string
	err := r.db.QueryRowContext(ctx, `SELECT image_path FROM cover_art WHERE id = ?`, coverID).Scan(&path)
	return path, err
}

// SetSongCover assigns a cover to a song. If the song has an album, the cover is
// recorded in album_covers and applied to every song of that artist+album (and,
// via Create, future ones). A song with no album gets a per-song cover only.
func (r *Repo) SetSongCover(ctx context.Context, songID, coverID string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var artistID string
	var album sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT artist_id, album FROM songs WHERE id = ?`, songID).Scan(&artistID, &album)
	if err != nil {
		return err
	}

	if key := albumKey(album.String); key != "" {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO album_covers(artist_id, album_key, cover_art_id) VALUES(?,?,?)
			 ON CONFLICT(artist_id, album_key) DO UPDATE SET cover_art_id = excluded.cover_art_id`,
			artistID, key, coverID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET cover_art_id = ? WHERE artist_id = ? AND lower(album) = ?`,
			coverID, artistID, key); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET cover_art_id = ? WHERE id = ?`, coverID, songID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// albumCoverIDTx returns the mapped cover id for an (artist, album), or "".
func albumCoverIDTx(ctx context.Context, tx *sql.Tx, artistID, album string) (string, error) {
	key := albumKey(album)
	if key == "" {
		return "", nil
	}
	var coverID string
	err := tx.QueryRowContext(ctx,
		`SELECT cover_art_id FROM album_covers WHERE artist_id = ? AND album_key = ?`,
		artistID, key).Scan(&coverID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return coverID, err
}

func albumKey(album string) string {
	return strings.ToLower(strings.TrimSpace(album))
}
```

- [ ] **Step 7: Run tests + full backend suite**

Run: `cd backend && go test ./internal/library/ ./internal/store/ ./internal/httpapi/ -v 2>&1 | tail -25`
Expected: PASS (new cover tests + existing Phase 2 tests, including the upload/stream tests, still green — `songSelect` change is transparent).

- [ ] **Step 8: Commit**

```bash
git add backend/internal/library/covers.go backend/internal/library/covers_test.go backend/internal/library/songs.go backend/internal/store/migrations/0003_album_covers.sql
git commit -m "feat(library): album-cover mapping with existing+future auto-match"
```

---

## Task 3: Image probe utility

**Files:**
- Create: `backend/internal/imageutil/imageutil.go`
- Test: `backend/internal/imageutil/imageutil_test.go`

**Interfaces:**
- Produces: `imageutil.Probe(r io.Reader) (width, height int, ext string, err error)` — decodes the image header only; returns `ext` `"jpg"` or `"png"`; returns `imageutil.ErrUnsupported` for anything else. `imageutil.ErrUnsupported`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/imageutil/imageutil_test.go`:
```go
package imageutil

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b.Bytes()
}

func TestProbe_jpeg(t *testing.T) {
	w, h, ext, err := Probe(bytes.NewReader(jpegBytes(t, 320, 200)))
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if w != 320 || h != 200 || ext != "jpg" {
		t.Fatalf("got %dx%d %q", w, h, ext)
	}
}

func TestProbe_png(t *testing.T) {
	_, _, ext, err := Probe(bytes.NewReader(pngBytes(t, 64, 64)))
	if err != nil || ext != "png" {
		t.Fatalf("png probe: ext=%q err=%v", ext, err)
	}
}

func TestProbe_rejectsNonImage(t *testing.T) {
	if _, _, _, err := Probe(strings.NewReader("not an image")); err == nil {
		t.Fatal("expected error for non-image")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/imageutil/ -v`
Expected: FAIL (undefined `Probe`).

- [ ] **Step 3: Write the implementation**

Create `backend/internal/imageutil/imageutil.go`:
```go
// Package imageutil validates and measures uploaded cover images.
package imageutil

import (
	"errors"
	"image"
	// Blank imports register the JPEG/PNG decoders with image.DecodeConfig.
	_ "image/jpeg"
	_ "image/png"
	"io"
)

// ErrUnsupported is returned for inputs that are not a supported image format.
var ErrUnsupported = errors.New("imageutil: unsupported image format")

// Probe reads only the image header and returns its dimensions and a normalized
// extension ("jpg" or "png"). Non-image or unsupported input yields ErrUnsupported.
func Probe(r io.Reader) (width, height int, ext string, err error) {
	cfg, format, err := image.DecodeConfig(r)
	if err != nil {
		return 0, 0, "", ErrUnsupported
	}
	switch format {
	case "jpeg":
		ext = "jpg"
	case "png":
		ext = "png"
	default:
		return 0, 0, "", ErrUnsupported
	}
	return cfg.Width, cfg.Height, ext, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/imageutil/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/imageutil/
git commit -m "feat(imageutil): validate + measure cover images (jpg/png)"
```

---

## Task 4: Tag editor endpoint + typeahead suggest

**Files:**
- Create: `backend/internal/httpapi/tags.go`
- Modify: `backend/internal/library/songs.go` (add `Update`, `Suggest`), `backend/internal/httpapi/server.go` (register routes), `backend/internal/httpapi/songs.go` (add `songHandlers.media` accessor is already present; reuse it)
- Test: `backend/internal/httpapi/tags_test.go`, extend `backend/internal/library/songs_test.go`

**Interfaces:**
- Consumes: `metadata.WriteTags`, `media.Store.Resolve`, `library.Repo`.
- Produces:
  - `library.UpdateSongParams{ Title, ArtistName, Album string; Year, TrackNo int; Genres []string; FileSize int64 }`
  - `(*Repo).Update(ctx, id string, p UpdateSongParams) (*Song, error)` — updates title/artist(upsert)/album/year/track, **replaces** the song's genres, updates `file_size`, keeps `content_hash`, and re-resolves the album cover for the (possibly new) artist+album (adopts that album's mapped cover, else leaves the existing cover). Returns the updated song.
  - `library.Suggestion{ Value string; Count int }`; `(*Repo).Suggest(ctx, field, q string) ([]Suggestion, error)` — `field` ∈ {`artist`,`album`,`genre`}; case-insensitive substring match; usage counts; max 10; unknown field ⇒ error.
  - Routes: `PATCH /api/songs/{id}` (auth) → updated song JSON; `GET /api/suggest?field=&q=` (auth) → `{"suggestions":[...]}`.

- [ ] **Step 1: Write the failing repository test**

Add to `backend/internal/library/songs_test.go`:
```go
func TestUpdate_editsFieldsAndReplacesGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	created, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	updated, err := r.Update(ctx, created.ID, UpdateSongParams{
		Title: "New Title", ArtistName: "New Artist", Album: "New Album",
		Year: 2001, TrackNo: 5, Genres: []string{"Jazz"}, FileSize: 999,
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Title != "New Title" || updated.ArtistName != "New Artist" || updated.Album != "New Album" {
		t.Fatalf("fields not updated: %+v", updated)
	}
	if len(updated.Genres) != 1 || updated.Genres[0] != "Jazz" {
		t.Fatalf("genres not replaced: %#v", updated.Genres)
	}
	if updated.ID != created.ID {
		t.Fatalf("id changed: %s -> %s", created.ID, updated.ID)
	}
}

func TestSuggest_artistAndGenreCounts(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	makeSong(t, r, "A", "Album", "h1", "songs/a.mp3") // Test Artist / Synthwave, Dream Pop
	makeSong(t, r, "B", "Album", "h2", "songs/b.mp3")

	got, err := r.Suggest(ctx, "artist", "test")
	if err != nil {
		t.Fatalf("Suggest artist: %v", err)
	}
	if len(got) != 1 || got[0].Value != "Test Artist" || got[0].Count != 2 {
		t.Fatalf("artist suggest = %#v", got)
	}
	gg, err := r.Suggest(ctx, "genre", "synth")
	if err != nil {
		t.Fatalf("Suggest genre: %v", err)
	}
	if len(gg) != 1 || gg[0].Value != "Synthwave" {
		t.Fatalf("genre suggest = %#v", gg)
	}
	if _, err := r.Suggest(ctx, "bogus", "x"); err == nil {
		t.Fatal("expected error for unknown field")
	}
}
```
(Uses `makeSong` from `covers_test.go` in the same package.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/library/ -run 'Update|Suggest' -v`
Expected: FAIL (undefined `Update`, `Suggest`, `UpdateSongParams`, `Suggestion`).

- [ ] **Step 3: Implement `Update` and `Suggest`**

Add to `backend/internal/library/songs.go` (or a new `edit.go` in the package — same package):
```go
// UpdateSongParams carries the editable fields for a tag edit.
type UpdateSongParams struct {
	Title      string
	ArtistName string
	Album      string
	Year       int
	TrackNo    int
	Genres     []string
	FileSize   int64
}

// Update edits a song's metadata: title/artist(upsert)/album/year/track, replaces
// its genres, refreshes file_size, and re-resolves the album cover for the new
// artist+album (adopting that album's mapped cover when one exists). content_hash
// is deliberately left unchanged — it is the import identity, not a live checksum.
func (r *Repo) Update(ctx context.Context, id string, p UpdateSongParams) (*Song, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	artistID, err := upsertArtist(ctx, tx, p.ArtistName)
	if err != nil {
		return nil, err
	}
	coverID, err := albumCoverIDTx(ctx, tx, artistID, p.Album)
	if err != nil {
		return nil, err
	}

	if coverID != "" {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, file_size=?, cover_art_id=?
			 WHERE id=?`,
			p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo), p.FileSize, coverID, id,
		); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`UPDATE songs SET title=?, artist_id=?, album=?, year=?, track_no=?, file_size=?
			 WHERE id=?`,
			p.Title, artistID, nullStr(p.Album), nullInt(p.Year), nullInt(p.TrackNo), p.FileSize, id,
		); err != nil {
			return nil, err
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM song_genres WHERE song_id=?`, id); err != nil {
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
			id, genreID, primary); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return r.Get(ctx, id)
}

// Suggestion is one typeahead candidate with its usage count.
type Suggestion struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

// Suggest returns up to 10 existing values for a field matching q (case-
// insensitive substring), most-used first.
func (r *Repo) Suggest(ctx context.Context, field, q string) ([]Suggestion, error) {
	like := "%" + strings.ToLower(strings.TrimSpace(q)) + "%"
	var query string
	switch field {
	case "artist":
		query = `SELECT a.name, COUNT(s.id) c FROM artists a JOIN songs s ON s.artist_id = a.id
			WHERE a.name_key LIKE ? GROUP BY a.id ORDER BY c DESC, a.name LIMIT 10`
	case "album":
		query = `SELECT s.album, COUNT(*) c FROM songs s
			WHERE s.album IS NOT NULL AND s.album != '' AND lower(s.album) LIKE ?
			GROUP BY lower(s.album) ORDER BY c DESC, s.album LIMIT 10`
	case "genre":
		query = `SELECT g.name, COUNT(sg.song_id) c FROM genres g JOIN song_genres sg ON sg.genre_id = g.id
			WHERE lower(g.name) LIKE ? GROUP BY g.id ORDER BY c DESC, g.name LIMIT 10`
	default:
		return nil, errors.New("library: unknown suggest field")
	}
	rows, err := r.db.QueryContext(ctx, query, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Suggestion{}
	for rows.Next() {
		var s Suggestion
		if err := rows.Scan(&s.Value, &s.Count); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
```
Add `"errors"` to the `songs.go` import block if you put `Suggest` there (it already imports `errors`).

- [ ] **Step 4: Run repo tests**

Run: `cd backend && go test ./internal/library/ -run 'Update|Suggest' -v`
Expected: PASS.

- [ ] **Step 5: Write the failing HTTP test**

Create `backend/internal/httpapi/tags_test.go`:
```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func patch(t *testing.T, h http.Handler, id string, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/api/songs/"+id, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPatchSong_editsTagsAndWritesFile(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := patch(t, h, song.ID, `{"title":"Renamed","artistName":"Test Artist","album":"Test Album","year":2020,"trackNo":3,"genres":["Ambient"]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		Title  string   `json:"title"`
		Genres []string `json:"genres"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)
	if updated.Title != "Renamed" || len(updated.Genres) != 1 || updated.Genres[0] != "Ambient" {
		t.Fatalf("edit not reflected: %+v", updated)
	}

	// Proof it hit the FILE: download the managed bytes and confirm the ID3 title.
	dl := httptest.NewRecorder()
	h.ServeHTTP(dl, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if !bytes.Contains(dl.Body.Bytes(), []byte("Renamed")) {
		t.Fatal("edited title not found in downloaded file bytes")
	}
}

func TestPatchSong_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC)
	// Need a song id to target; upload as dev on a separate authed server, but
	// here anonymous PATCH to any id must be rejected before touching storage.
	rr := patch(t, h, "does-not-matter", `{"title":"x","artistName":"y","genres":[]}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous PATCH = %d, want 403", rr.Code)
	}
}

func TestSuggest_authOnly(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadFixture(t, h)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/suggest?field=artist&q=test", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("suggest status = %d", rr.Code)
	}
	var body struct {
		Suggestions []struct {
			Value string `json:"value"`
			Count int    `json:"count"`
		} `json:"suggestions"`
	}
	json.Unmarshal(rr.Body.Bytes(), &body)
	if len(body.Suggestions) != 1 || body.Suggestions[0].Value != "Test Artist" {
		t.Fatalf("suggest = %+v", body)
	}

	anon := testServer(t, config.AuthModeOIDC)
	ar := httptest.NewRecorder()
	anon.ServeHTTP(ar, httptest.NewRequest("GET", "/api/suggest?field=artist&q=test", nil))
	if ar.Code != http.StatusForbidden {
		t.Fatalf("anonymous suggest = %d, want 403", ar.Code)
	}
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run 'PatchSong|Suggest' -v`
Expected: FAIL (routes not registered).

- [ ] **Step 7: Write the handlers**

Create `backend/internal/httpapi/tags.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/metadata"
)

type editSongRequest struct {
	Title      string   `json:"title"`
	ArtistName string   `json:"artistName"`
	Album      string   `json:"album"`
	Year       int      `json:"year"`
	TrackNo    int      `json:"trackNo"`
	Genres     []string `json:"genres"`
}

func (h *songHandlers) patch(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	var req editSongRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.Title == "" {
		httpError(w, http.StatusBadRequest, "title is required")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}

	// Write to the FILE first (crash-safe rename inside WriteTags): if this fails
	// the DB is untouched.
	abs, err := h.media.Resolve(song.FilePath)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "resolve file")
		return
	}
	if err := metadata.WriteTags(abs, metadata.WriteableTags{
		Title: req.Title, Artist: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres,
	}); err != nil {
		httpError(w, http.StatusInternalServerError, "write tags")
		return
	}
	var size int64
	if info, err := os.Stat(abs); err == nil {
		size = info.Size()
	}

	updated, err := h.repo.Update(r.Context(), song.ID, library.UpdateSongParams{
		Title: req.Title, ArtistName: req.ArtistName, Album: req.Album,
		Year: req.Year, TrackNo: req.TrackNo, Genres: req.Genres, FileSize: size,
	})
	if err != nil {
		httpError(w, http.StatusInternalServerError, "update song")
		return
	}
	writeJSON(w, updated)
}

func (h *songHandlers) suggest(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	field := r.URL.Query().Get("field")
	q := r.URL.Query().Get("q")
	out, err := h.repo.Suggest(r.Context(), field, q)
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid suggest field")
		return
	}
	writeJSON(w, map[string]any{"suggestions": out})
}
```

- [ ] **Step 8: Register the routes**

In `backend/internal/httpapi/server.go`, inside the `if st != nil && cfg.MediaDir != ""` block, add after the existing song routes:
```go
			mux.HandleFunc("PATCH /api/songs/{id}", h.patch)
			mux.HandleFunc("GET /api/suggest", h.suggest)
```

- [ ] **Step 9: Run tests + build**

Run: `cd backend && go test ./internal/httpapi/ ./internal/library/ -v 2>&1 | tail -20 && CGO_ENABLED=0 go build ./...`
Expected: PASS; build OK.

- [ ] **Step 10: Commit**

```bash
git add backend/internal/httpapi/tags.go backend/internal/httpapi/tags_test.go backend/internal/httpapi/server.go backend/internal/library/songs.go backend/internal/library/songs_test.go
git commit -m "feat(httpapi): tag editor (ID3 write-back) + typeahead suggest"
```

---

## Task 5: Cover upload/serve + artist & genre browse

**Files:**
- Create: `backend/internal/httpapi/covers.go`, `backend/internal/httpapi/browse.go`
- Modify: `backend/internal/library/songs.go` (add `ListArtists`, `GetArtist`, `ListGenres`, `GetGenre`), `backend/internal/httpapi/server.go`
- Test: `backend/internal/httpapi/covers_test.go`, `backend/internal/httpapi/browse_test.go`, extend `songs_test.go`

**Interfaces:**
- Consumes: `imageutil.Probe`, `library.Repo` (`CreateCover`, `SetSongCover`, `GetCoverPath`), `media.Store`.
- Produces:
  - `library.ArtistSummary{ ID, Name string; SongCount int }`, `library.GenreSummary{ ID, Name string; SongCount int }`.
  - `(*Repo).ListArtists(ctx) ([]ArtistSummary, error)`, `(*Repo).GetArtist(ctx, id) (*ArtistSummary, []Song, error)`.
  - `(*Repo).ListGenres(ctx) ([]GenreSummary, error)`, `(*Repo).GetGenre(ctx, id) (*GenreSummary, []Song, error)`.
  - Routes: `PUT /api/songs/{id}/cover` (auth, multipart `file`) → updated song; `GET /api/cover/{id}` (public) → image bytes; `GET /api/artists`, `GET /api/artists/{id}`, `GET /api/genres`, `GET /api/genres/{id}` (public).

- [ ] **Step 1: Write the failing repo test**

Add to `backend/internal/library/songs_test.go`:
```go
func TestBrowse_artistsAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	makeSong(t, r, "A", "Album", "h1", "songs/a.mp3")
	makeSong(t, r, "B", "Album", "h2", "songs/b.mp3")

	artists, err := r.ListArtists(ctx)
	if err != nil {
		t.Fatalf("ListArtists: %v", err)
	}
	if len(artists) != 1 || artists[0].Name != "Test Artist" || artists[0].SongCount != 2 {
		t.Fatalf("artists = %#v", artists)
	}
	art, songs, err := r.GetArtist(ctx, artists[0].ID)
	if err != nil || art == nil {
		t.Fatalf("GetArtist: %v", err)
	}
	if len(songs) != 2 {
		t.Fatalf("artist songs = %d, want 2", len(songs))
	}

	genres, err := r.ListGenres(ctx)
	if err != nil {
		t.Fatalf("ListGenres: %v", err)
	}
	// Fixture has two genres: Synthwave, Dream Pop.
	if len(genres) != 2 {
		t.Fatalf("genres = %#v", genres)
	}
	_, gsongs, err := r.GetGenre(ctx, genres[0].ID)
	if err != nil {
		t.Fatalf("GetGenre: %v", err)
	}
	if len(gsongs) != 2 {
		t.Fatalf("genre songs = %d, want 2", len(gsongs))
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && go test ./internal/library/ -run TestBrowse -v`
Expected: FAIL (undefined `ListArtists`, …).

- [ ] **Step 3: Implement browse methods**

Add to `backend/internal/library/songs.go` (or a new `browse.go` in the package):
```go
// ArtistSummary is an artist with its song count for browse lists.
type ArtistSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SongCount int    `json:"songCount"`
}

// GenreSummary is a genre with its song count.
type GenreSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	SongCount int    `json:"songCount"`
}

func (r *Repo) ListArtists(ctx context.Context) ([]ArtistSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT a.id, a.name, COUNT(s.id) c FROM artists a JOIN songs s ON s.artist_id = a.id
		 GROUP BY a.id ORDER BY a.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ArtistSummary{}
	for rows.Next() {
		var a ArtistSummary
		if err := rows.Scan(&a.ID, &a.Name, &a.SongCount); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *Repo) GetArtist(ctx context.Context, id string) (*ArtistSummary, []Song, error) {
	var a ArtistSummary
	err := r.db.QueryRowContext(ctx,
		`SELECT a.id, a.name, COUNT(s.id) c FROM artists a LEFT JOIN songs s ON s.artist_id = a.id
		 WHERE a.id = ? GROUP BY a.id`, id).Scan(&a.ID, &a.Name, &a.SongCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	songs, err := r.songsWhere(ctx, `s.artist_id = ?`, id)
	return &a, songs, err
}

func (r *Repo) ListGenres(ctx context.Context) ([]GenreSummary, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT g.id, g.name, COUNT(sg.song_id) c FROM genres g JOIN song_genres sg ON sg.genre_id = g.id
		 GROUP BY g.id ORDER BY g.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GenreSummary{}
	for rows.Next() {
		var g GenreSummary
		if err := rows.Scan(&g.ID, &g.Name, &g.SongCount); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (r *Repo) GetGenre(ctx context.Context, id string) (*GenreSummary, []Song, error) {
	var g GenreSummary
	err := r.db.QueryRowContext(ctx,
		`SELECT g.id, g.name, COUNT(sg.song_id) c FROM genres g LEFT JOIN song_genres sg ON sg.genre_id = g.id
		 WHERE g.id = ? GROUP BY g.id`, id).Scan(&g.ID, &g.Name, &g.SongCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	songs, err := r.songsWhere(ctx,
		`s.id IN (SELECT song_id FROM song_genres WHERE genre_id = ?)`, id)
	return &g, songs, err
}

// songsWhere runs songSelect with an extra WHERE clause and hydrates genres.
func (r *Repo) songsWhere(ctx context.Context, where string, args ...any) ([]Song, error) {
	rows, err := r.db.QueryContext(ctx, songSelect+" WHERE "+where+" ORDER BY s.created_at DESC, s.id DESC", args...)
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
```

- [ ] **Step 4: Run repo tests**

Run: `cd backend && go test ./internal/library/ -run TestBrowse -v`
Expected: PASS.

- [ ] **Step 5: Write the failing HTTP tests**

Create `backend/internal/httpapi/covers_test.go`:
```go
package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func uploadCover(t *testing.T, h http.Handler, songID string) *httptest.ResponseRecorder {
	t.Helper()
	var img bytes.Buffer
	jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 300, 300)), nil)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "cover.jpg")
	fw.Write(img.Bytes())
	mw.Close()
	req := httptest.NewRequest("PUT", "/api/songs/"+songID+"/cover", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPutCover_setsAndServes(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := uploadCover(t, h, song.ID)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT cover = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)
	if updated.CoverArtID == "" {
		t.Fatal("song has no coverArtId after upload")
	}

	// Served publicly with an image content-type.
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, httptest.NewRequest("GET", "/api/cover/"+updated.CoverArtID, nil))
	if cr.Code != http.StatusOK {
		t.Fatalf("GET cover = %d", cr.Code)
	}
	if ct := cr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("cover content-type = %q", ct)
	}
}

func TestPutCover_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC)
	rr := uploadCover(t, h, "any")
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous cover PUT = %d, want 403", rr.Code)
	}
}
```

Create `backend/internal/httpapi/browse_test.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func TestBrowseEndpoints_public(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadFixture(t, h)

	ar := httptest.NewRecorder()
	h.ServeHTTP(ar, httptest.NewRequest("GET", "/api/artists", nil))
	if ar.Code != http.StatusOK {
		t.Fatalf("GET /api/artists = %d", ar.Code)
	}
	var artists struct {
		Artists []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			SongCount int    `json:"songCount"`
		} `json:"artists"`
	}
	json.Unmarshal(ar.Body.Bytes(), &artists)
	if len(artists.Artists) != 1 || artists.Artists[0].SongCount != 1 {
		t.Fatalf("artists = %+v", artists)
	}

	gr := httptest.NewRecorder()
	h.ServeHTTP(gr, httptest.NewRequest("GET", "/api/genres", nil))
	if gr.Code != http.StatusOK {
		t.Fatalf("GET /api/genres = %d", gr.Code)
	}
}
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd backend && go test ./internal/httpapi/ -run 'Cover|Browse' -v`
Expected: FAIL (routes not registered).

- [ ] **Step 7: Write the cover handlers**

Create `backend/internal/httpapi/covers.go`:
```go
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
)

func (h *songHandlers) putCover(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get song")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if asMaxBytes(err, &tooLarge) {
			httpError(w, http.StatusRequestEntityTooLarge, "image exceeds size limit")
			return
		}
		httpError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	// Buffer to a temp file so we can probe, hash, and store from one copy.
	tmp, err := os.CreateTemp("", "music-cover-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "temp file")
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), file); err != nil {
		httpError(w, http.StatusBadRequest, "read upload")
		return
	}
	hash := hex.EncodeToString(hasher.Sum(nil))

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		httpError(w, http.StatusInternalServerError, "seek")
		return
	}
	width, height, ext, err := imageutil.Probe(tmp)
	if err != nil {
		httpError(w, http.StatusUnsupportedMediaType, "unsupported image format")
		return
	}

	// Dedupe: reuse an existing identical image; else store a new file.
	coverID, existingPath, err := h.repo.FindCoverByHash(r.Context(), hash)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cover lookup")
		return
	}
	if coverID == "" {
		relPath := "covers/" + hash + "." + ext
		dst, err := h.media.Create(relPath)
		if err != nil {
			httpError(w, http.StatusInternalServerError, "store cover")
			return
		}
		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			dst.Close()
			httpError(w, http.StatusInternalServerError, "seek")
			return
		}
		if _, err := io.Copy(dst, tmp); err != nil {
			dst.Close()
			httpError(w, http.StatusInternalServerError, "write cover")
			return
		}
		if err := dst.Close(); err != nil {
			httpError(w, http.StatusInternalServerError, "close cover")
			return
		}
		coverID, err = h.repo.CreateCover(r.Context(), library.CoverParams{
			ImagePath: relPath, Width: width, Height: height, ContentHash: hash,
		})
		if err != nil {
			_ = h.media.Remove(relPath)
			httpError(w, http.StatusInternalServerError, "save cover")
			return
		}
	} else {
		_ = existingPath // already stored; reuse the row
	}

	if err := h.repo.SetSongCover(r.Context(), song.ID, coverID); err != nil {
		httpError(w, http.StatusInternalServerError, "assign cover")
		return
	}
	updated, err := h.repo.Get(r.Context(), song.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "reload song")
		return
	}
	writeJSON(w, updated)
}

func (h *songHandlers) getCover(w http.ResponseWriter, r *http.Request) {
	path, err := h.repo.GetCoverPath(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	f, err := h.media.Open(path)
	if err != nil {
		httpError(w, http.StatusNotFound, "cover file missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "stat cover")
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(path)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

// asMaxBytes wraps errors.As for *http.MaxBytesError without importing errors twice.
func asMaxBytes(err error, target **http.MaxBytesError) bool {
	return errorsAs(err, target)
}
```

Add a tiny shared helper (once) in `backend/internal/httpapi/songs.go` — replace the inline `errors.As` in the existing upload handler is unnecessary; instead add near the bottom of `songs.go`:
```go
// errorsAs is a thin indirection so cover.go can share the same errors.As call.
func errorsAs(err error, target any) bool {
	return errors.As(err, target)
}
```
(`songs.go` already imports `errors`.)

- [ ] **Step 8: Write the browse handlers**

Create `backend/internal/httpapi/browse.go`:
```go
package httpapi

import "net/http"

func (h *songHandlers) listArtists(w http.ResponseWriter, r *http.Request) {
	artists, err := h.repo.ListArtists(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list artists")
		return
	}
	writeJSON(w, map[string]any{"artists": artists})
}

func (h *songHandlers) getArtist(w http.ResponseWriter, r *http.Request) {
	artist, songs, err := h.repo.GetArtist(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get artist")
		return
	}
	if artist == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, map[string]any{"artist": artist, "songs": songs})
}

func (h *songHandlers) listGenres(w http.ResponseWriter, r *http.Request) {
	genres, err := h.repo.ListGenres(r.Context())
	if err != nil {
		httpError(w, http.StatusInternalServerError, "list genres")
		return
	}
	writeJSON(w, map[string]any{"genres": genres})
}

func (h *songHandlers) getGenre(w http.ResponseWriter, r *http.Request) {
	genre, songs, err := h.repo.GetGenre(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "get genre")
		return
	}
	if genre == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, map[string]any{"genre": genre, "songs": songs})
}
```

- [ ] **Step 9: Register the routes**

In `server.go`, inside the same handler block, add:
```go
			mux.HandleFunc("PUT /api/songs/{id}/cover", h.putCover)
			mux.HandleFunc("GET /api/cover/{id}", h.getCover)
			mux.HandleFunc("GET /api/artists", h.listArtists)
			mux.HandleFunc("GET /api/artists/{id}", h.getArtist)
			mux.HandleFunc("GET /api/genres", h.listGenres)
			mux.HandleFunc("GET /api/genres/{id}", h.getGenre)
```

- [ ] **Step 10: Run the whole backend suite + build**

Run: `cd backend && go test ./... 2>&1 | tail -12 && CGO_ENABLED=0 go build ./...`
Expected: PASS across all packages; CGO-free build OK.

- [ ] **Step 11: Commit**

```bash
git add backend/internal/httpapi/covers.go backend/internal/httpapi/covers_test.go backend/internal/httpapi/browse.go backend/internal/httpapi/browse_test.go backend/internal/httpapi/server.go backend/internal/httpapi/songs.go backend/internal/library/songs.go backend/internal/library/songs_test.go
git commit -m "feat(httpapi): cover upload/serve with auto-match + artist/genre browse"
```

---

## Task 6: Frontend — tag-editor modal, typeahead, cover thumbnails

**Files:**
- Create: `ui/src/cover.ts`, `ui/src/cover.test.ts`, `ui/src/TagEditor.tsx`
- Modify: `ui/src/api.ts`, `ui/src/App.tsx`

**Interfaces:**
- Consumes: `PATCH /api/songs/{id}`, `GET /api/suggest`, `PUT /api/songs/{id}/cover`, `GET /api/cover/{id}`.
- Produces: cover-url + fallback-initial helpers; an `Edit` affordance on each song row (authenticated only) opening a modal that edits fields with artist/album/genre typeahead and replaces the cover; song rows show a cover thumbnail or the no-cover fallback tile.

- [ ] **Step 1: Write the failing cover-helper test**

Create `ui/src/cover.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { coverUrl, coverInitial } from "./cover";

describe("cover helpers", () => {
  it("builds a cover url from an id", () => {
    expect(coverUrl("abc")).toBe("/api/cover/abc");
  });
  it("returns empty url for no cover", () => {
    expect(coverUrl("")).toBe("");
  });
  it("derives an uppercase initial", () => {
    expect(coverInitial("marisol")).toBe("M");
    expect(coverInitial("")).toBe("?");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npm run test -- --run cover`
Expected: FAIL (cannot resolve `./cover`).

- [ ] **Step 3: Write the helpers**

Create `ui/src/cover.ts`:
```ts
export function coverUrl(coverArtId: string): string {
  return coverArtId ? `/api/cover/${coverArtId}` : "";
}

export function coverInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npm run test -- --run cover`
Expected: PASS.

- [ ] **Step 5: Extend the API client**

In `ui/src/api.ts`, add `coverArtId` to `Song` and add calls:
```ts
export type Song = {
  id: string;
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  durationMs: number;
  genres: string[];
  coverArtId: string;
};

export type SongEdit = {
  title: string;
  artistName: string;
  album: string;
  year: number;
  trackNo: number;
  genres: string[];
};

export type Suggestion = { value: string; count: number };

export async function updateSong(id: string, edit: SongEdit): Promise<Song> {
  const r = await fetch(`/api/songs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edit),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  return r.json();
}

export async function suggest(field: "artist" | "album" | "genre", q: string): Promise<Suggestion[]> {
  const r = await fetch(`/api/suggest?field=${field}&q=${encodeURIComponent(q)}`);
  if (!r.ok) return [];
  const data = await r.json();
  return data.suggestions ?? [];
}

export async function uploadCover(id: string, file: File): Promise<Song> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch(`/api/songs/${id}/cover`, { method: "PUT", body: form });
  if (!r.ok) throw new Error(`cover upload failed (${r.status})`);
  return r.json();
}
```

- [ ] **Step 6: Write the tag-editor modal**

Create `ui/src/TagEditor.tsx`:
```tsx
import { useState } from "react";
import { updateSong, uploadCover, suggest, type Song, type Suggestion } from "./api";
import { coverUrl, coverInitial } from "./cover";

type Props = { song: Song; onClose: () => void; onSaved: (s: Song) => void };

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--color-bg)", color: "var(--color-ink)",
  border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase",
  color: "var(--color-muted)", marginBottom: 4,
};

export function TagEditor({ song, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(song.title);
  const [artistName, setArtist] = useState(song.artistName);
  const [album, setAlbum] = useState(song.album);
  const [year, setYear] = useState(song.year ? String(song.year) : "");
  const [trackNo, setTrack] = useState(song.trackNo ? String(song.trackNo) : "");
  const [genres, setGenres] = useState<string[]>(song.genres);
  const [genreInput, setGenreInput] = useState("");
  const [cover, setCover] = useState(song.coverArtId);
  const [artistOpts, setArtistOpts] = useState<Suggestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addGenre = (g: string) => {
    const v = g.trim();
    if (v && !genres.some((x) => x.toLowerCase() === v.toLowerCase())) setGenres([...genres, v]);
    setGenreInput("");
  };

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      const saved = await updateSong(song.id, {
        title, artistName, album,
        year: Number(year) || 0, trackNo: Number(trackNo) || 0, genres,
      });
      onSaved(saved);
      onClose();
    } catch {
      setErr("Could not save changes");
      setSaving(false);
    }
  };

  const onCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const saved = await uploadCover(song.id, file);
      setCover(saved.coverArtId);
      onSaved(saved);
    } catch {
      setErr("Cover upload failed");
    }
    e.target.value = "";
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", padding: "1rem", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 100%)", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "1.25rem", maxHeight: "90vh", overflow: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Edit tags</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.2rem" }}>×</button>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
          <div style={{ width: 120, flexShrink: 0 }}>
            <div style={{ width: 120, height: 120, borderRadius: 10, overflow: "hidden", border: "1px solid var(--color-border)", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
              {cover ? (
                <img src={coverUrl(cover)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(artistName)}</span>
              )}
            </div>
            <label style={{ display: "block", marginTop: 8, textAlign: "center", fontSize: "0.8rem", color: "var(--color-accent-strong)", cursor: "pointer" }}>
              Replace cover
              <input type="file" accept="image/jpeg,image/png" onChange={onCover} style={{ display: "none" }} />
            </label>
            <p style={{ fontSize: "0.68rem", color: "var(--color-muted)", textAlign: "center", marginTop: 6 }}>
              Applies to every track on this artist + album.
            </p>
          </div>

          <div style={{ flex: 1, display: "grid", gap: "0.7rem" }}>
            <div>
              <label style={labelStyle}>Title</label>
              <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div style={{ position: "relative" }}>
              <label style={labelStyle}>Artist</label>
              <input
                style={inputStyle}
                value={artistName}
                onChange={async (e) => { setArtist(e.target.value); setArtistOpts(await suggest("artist", e.target.value)); }}
                onBlur={() => setTimeout(() => setArtistOpts([]), 150)}
              />
              {artistOpts.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 8, zIndex: 5 }}>
                  {artistOpts.map((o) => (
                    <div key={o.value} onMouseDown={() => { setArtist(o.value); setArtistOpts([]); }}
                      style={{ padding: "0.4rem 0.6rem", cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
                      <span>{o.value}</span><span style={{ color: "var(--color-muted)" }}>{o.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label style={labelStyle}>Album</label>
              <input style={inputStyle} value={album} onChange={(e) => setAlbum(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Genres</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {genres.map((g) => (
                  <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--color-active)", borderRadius: 999, padding: "0.15rem 0.55rem", fontSize: "0.8rem" }}>
                    {g}
                    <button onClick={() => setGenres(genres.filter((x) => x !== g))} aria-label={`Remove ${g}`} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>×</button>
                  </span>
                ))}
              </div>
              <input
                style={inputStyle}
                placeholder="Add genre and press Enter"
                value={genreInput}
                onChange={(e) => setGenreInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGenre(genreInput); } }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.7rem" }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Year</label>
                <input style={inputStyle} value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Track no.</label>
                <input style={inputStyle} value={trackNo} onChange={(e) => setTrack(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </div>
        </div>

        {err && <p style={{ color: "var(--color-accent-strong)" }}>{err}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
          <span style={{ fontSize: "0.72rem", color: "var(--color-muted)" }}>Changes save to the file's ID3 tags</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>Cancel</button>
            <button onClick={onSave} disabled={saving} style={{ background: "var(--color-accent)", border: "none", color: "#fff", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Wire cover thumbnails + edit affordance into App.tsx**

In `ui/src/App.tsx`:

Add imports at the top:
```tsx
import { TagEditor } from "./TagEditor";
import { coverUrl, coverInitial } from "./cover";
```

Add editor state near the other `useState` calls:
```tsx
  const [editing, setEditing] = useState<Song | null>(null);
```

Inside the `songs.map(...)` `<li>`, prepend a cover thumbnail as the first child of the row (before the title/artist `<span>` block) and append an Edit button (authenticated only) after the duration. Replace the existing `<li>` body with:
```tsx
              <li
                key={song.id}
                onClick={() => play(song)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.85rem",
                  padding: "0.6rem 0.85rem",
                  borderRadius: "var(--radius-ui, 10px)",
                  cursor: "pointer",
                  background: active ? "var(--color-active)" : "transparent",
                }}
              >
                <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", border: "1px solid var(--color-border)" }}>
                  {song.coverArtId ? (
                    <img src={coverUrl(song.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: "0.9rem", color: "var(--color-muted)" }}>{coverInitial(song.artistName)}</span>
                  )}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
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
                {session?.authenticated && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditing(song); }}
                    style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.25rem 0.6rem", cursor: "pointer", fontSize: "0.8rem", flexShrink: 0 }}
                  >
                    Edit
                  </button>
                )}
              </li>
```

Before the closing `</div>` of the component (after the now-playing block), add the modal:
```tsx
      {editing && (
        <TagEditor
          song={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setSongs((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
            setEditing(saved);
          }}
        />
      )}
```

- [ ] **Step 8: Run Vitest + build**

Run:
```bash
cd ui && npm run test -- --run && npm run build
cd ../backend && CGO_ENABLED=0 go build ./...
```
Expected: all Vitest tests pass; `vite build` writes `backend/web/dist`; Go build OK.

- [ ] **Step 9: Restore the dist placeholder and commit source**

```bash
cd /Users/jan/localgit/music
printf '<!doctype html><meta charset="utf-8"><title>Music</title><div id="root">build the UI: make fe-build</div>' > backend/web/dist/index.html
git add ui/src/cover.ts ui/src/cover.test.ts ui/src/TagEditor.tsx ui/src/api.ts ui/src/App.tsx
git commit -m "feat(ui): tag editor modal with typeahead + cover thumbnails"
```

---

## Task 7: End-to-end Playwright validation, PR, review, merge

**Files:** none (drives the running app).

- [ ] **Step 1: Build and run on a clean data dir**

Run:
```bash
make build
rm -rf /tmp/music-e2e3 && mkdir -p /tmp/music-e2e3
BACKEND_SESSION_SECRET=e2e3 BACKEND_AUTH_MODE=dev \
  BACKEND_DB_PATH=/tmp/music-e2e3/music.db BACKEND_MEDIA_DIR=/tmp/music-e2e3/media \
  ./bin/music &
sleep 2 && curl -s localhost:8080/api/health
```
Expected: `{"status":"ok"}`. Leave running.

- [ ] **Step 2: Seed two songs of the same artist+album via curl**

The fixture is `Test Artist / Test Album`. Upload it, then upload a **second** file with the same artist+album (copy the fixture; content differs only if bytes differ — so make a second distinct file by re-encoding). Create a sibling fixture and upload both:
```bash
ffmpeg -y -f lavfi -i "sine=frequency=330:duration=1" -ac 2 -ar 44100 -b:a 128k \
  -metadata title="Second Track" -metadata artist="Test Artist" -metadata album="Test Album" \
  -metadata genre="Synthwave" -id3v2_version 3 /tmp/music-e2e3/second.mp3
curl -s -o /dev/null -F "file=@backend/internal/metadata/testdata/sample.mp3" localhost:8080/api/songs
curl -s -o /dev/null -F "file=@/tmp/music-e2e3/second.mp3" localhost:8080/api/songs
curl -s localhost:8080/api/songs | grep -o '"title":"[^"]*"'
```
Expected: two songs — `Test Song` and `Second Track`.

- [ ] **Step 3: Drive the tag editor with Playwright MCP (proves file write)**

Using the Playwright MCP browser tools:
1. `browser_navigate` → `http://localhost:8080/`; `browser_snapshot` shows both rows, each with an **Edit** button (dev authenticated).
2. `browser_click` the **Edit** button on the `Test Song` row → the "Edit tags" modal appears.
3. Change the Title field to `Edited Live` (clear + type), then `browser_click` **Save changes**.
4. `browser_snapshot` — confirm the row now reads `Edited Live`.
5. **Prove it hit the file**, not just the DB — via `browser_evaluate`:
   ```js
   async () => {
     const list = await (await fetch('/api/songs')).json();
     const s = list.songs.find(x => x.title === 'Edited Live');
     const buf = await (await fetch('/api/songs/' + s.id + '/download')).arrayBuffer();
     const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
     return { found: text.includes('Edited Live') };
   }
   ```
   Expect `{ found: true }` — the edited title is present in the downloaded ID3 bytes.

- [ ] **Step 4: Drive cover auto-match with Playwright MCP (sibling + future upload)**

1. In the still-open (or re-opened) `Test Song` editor, `browser_click` **Replace cover** and `browser_file_upload` a JPEG. Generate one first on disk:
   ```bash
   ffmpeg -y -f lavfi -i "color=c=orange:s=400x400:d=1" -frames:v 1 /tmp/music-e2e3/cover.jpg
   ```
   Upload `/tmp/music-e2e3/cover.jpg`.
2. `browser_evaluate` to confirm the **sibling** (`Second Track`, same artist+album) also shows the cover:
   ```js
   async () => {
     const { songs } = await (await fetch('/api/songs')).json();
     const withCover = songs.filter(s => s.coverArtId);
     return { count: withCover.length, ids: withCover.map(s => s.title) };
   }
   ```
   Expect `count: 2` including both `Test Song`/`Edited Live` and `Second Track` — auto-match propagated to the existing sibling.
3. Confirm a **future** upload inherits it: upload a third same-album file and re-check:
   ```bash
   ffmpeg -y -f lavfi -i "sine=frequency=220:duration=1" -ac 2 -ar 44100 -b:a 128k \
     -metadata title="Third Track" -metadata artist="Test Artist" -metadata album="Test Album" \
     -id3v2_version 3 /tmp/music-e2e3/third.mp3
   curl -s -o /dev/null -F "file=@/tmp/music-e2e3/third.mp3" localhost:8080/api/songs
   ```
   Then `browser_navigate` reload and confirm `Third Track` also has a cover thumbnail (re-run the evaluate; expect `count: 3`).
4. `browser_navigate` → `GET /api/cover/<id>` implicitly via the thumbnail; confirm no broken image in `browser_snapshot`.

- [ ] **Step 5: Confirm anonymous read-only via curl**

```bash
# Public browse works.
curl -s -o /dev/null -w "artists:%{http_code} genres:" localhost:8080/api/artists
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/genres
# Suggest is auth-only; dev server is authenticated, so this returns 200 here —
# the anonymous 403 is covered by the Go test TestSuggest_authOnly.
curl -s "localhost:8080/api/suggest?field=artist&q=test" | grep -o '"value":"[^"]*"'
```
Expected: `artists:200 genres:200`; a suggestion value `Test Artist`.

- [ ] **Step 6: Tear down**

Run: `pkill -f 'bin/music'`.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin feat/phase-3-artists-genres-tags
gh pr create --repo trick77/music --base master --head feat/phase-3-artists-genres-tags \
  --title "feat: Phase 3 — artists, genres & tags" \
  --body "Tag editor with crash-safe ID3 write-back (verified against on-disk bytes), artist/album/genre typeahead, artist+album cover auto-match applying to existing AND future songs, cover serve + no-cover fallback, and artist/genre browse endpoints. Playwright e2e covers file-level tag write, sibling + future-upload cover match."
```
**Fork check:** `trick77/music` is the user's own repo (not a fork); PR targets **this** repo's `master`. Confirm base before creating.

- [ ] **Step 8: Gate on a code-review agent, then merge**

Dispatch a generic code-review agent (Agent tool `subagent_type: "general-purpose"`, or the `code-review` skill) over the PR diff. Address findings with follow-up commits, then:
```bash
gh pr merge --repo trick77/music --squash --delete-branch
```
Only merge after review findings are resolved and tests are green. Confirm the merge targets **this repo's** `master`, never an upstream.

---

## Self-review notes

- **Spec coverage (Phase 3 scope):** tag editor writing to file's ID3 tags + DB (§10) ✓ (Tasks 1, 4; e2e proves file write); multi-chip genres (§10) ✓ (TagEditor); typeahead on artist/album/genre with counts (§10, §12) ✓ (Task 4, auth-gated); artist+album cover auto-match to **existing and future** songs (§7) ✓ (Task 2 `album_covers` + `Create` inheritance; e2e sibling + future); singles get per-song cover (§7) ✓; no-cover fallback tile (§7, §15) ✓ (Task 6 `coverInitial`); cover serve `GET /api/cover/{id}` public + write endpoints auth-gated (§12, §14) ✓; artist/genre browse (§12) ✓ (Task 5). Deferred correctly: fanart/generation/imagescale (Phase 5), playlists (Phase 4), immersive pages (Phase 6), album-artist/comment editing (preserved, not edited).
- **Crash safety:** `WriteTags` relies on `bogem/id3v2` `Save()` (temp-file + `os.Rename`, confirmed in v2.1.4 source); tests assert duration-unchanged (audio survives) and field independence (parsed tag mutated, not rebuilt). Tag edit writes the file **before** the DB so a failure leaves the DB consistent.
- **content_hash:** intentionally left stable on edit (import identity, sidesteps the `0002` unique index); `file_size` refreshed from `Stat`.
- **Type consistency:** `library.Song.CoverArtID` (`coverArtId`) flows to the frontend `Song`; `UpdateSongParams`/`CoverParams`/`Suggestion`/`ArtistSummary`/`GenreSummary` are consumed exactly as defined; `WriteableTags` matches the handler; `New(cfg, st, spa)` unchanged (routes added inside the existing block).
- **Migrations:** `0003` only adds `album_covers`; `0001`/`0002` untouched; runner applies it in order.
- **Placeholders:** none — every code step carries complete code and exact commands.
