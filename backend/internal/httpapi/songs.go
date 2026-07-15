package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/trick77/music/internal/align"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/metadata"
	"github.com/trick77/music/internal/studio"
)

type songHandlers struct {
	cfg      config.Config
	repo     *library.Repo
	media    *media.Store
	maxBytes int64

	imageGen      imagegen.Provider
	bflModel      string
	onGenComplete func(id string)

	// aligner talks to the word-timing alignment sidecar (nil when unconfigured).
	// onAlignComplete is a test hook fired after an alignment goroutine finishes.
	aligner         aligner
	onAlignComplete func(id string)

	// genrePrompter authors an editable example prompt from a genre name (one-shot
	// LLM, no research). Nil when the chat key is unset, which makes the
	// suggest-prompt route answer 404.
	genrePrompter studio.GenrePrompter

	throttle *playThrottle

	// alignQueue feeds the single serial alignment worker (Phase 3). All triggers
	// (manual, import, save) funnel through enqueueAlignment onto this channel so
	// the one-at-a-time sidecar is never stampeded. Nil until initAlignQueue runs.
	alignQueue chan alignJob
}

func (h *songHandlers) list(w http.ResponseWriter, r *http.Request) {
	songs, err := h.repo.List(r.Context(), identify(h.cfg, r).Authenticated)
	if err != nil {
		serverError(w, "list songs", err)
		return
	}
	writeJSON(w, map[string]any{"songs": songs})
}

func (h *songHandlers) get(w http.ResponseWriter, r *http.Request) {
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	// Unpublished songs are invisible to anonymous callers even by direct id.
	if song == nil || (!song.Published && !identify(h.cfg, r).Authenticated) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, song)
}

// delete removes a song (authed-only): its row (cascading to plays, playlist
// entries, and genre links) and its audio file. Shared cover art is left intact.
func (h *songHandlers) delete(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	filePath, existed, err := h.repo.DeleteSong(r.Context(), r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "delete song")
		return
	}
	if !existed {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if filePath != "" {
		_ = h.media.Remove(filePath) // best-effort; missing file is not an error
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *songHandlers) upload(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpError(w, http.StatusRequestEntityTooLarge, "file exceeds size limit")
			return
		}
		httpError(w, http.StatusBadRequest, "missing file field")
		return
	}
	defer file.Close()
	// net/http spills large multipart parts to disk and does not auto-delete
	// them; clean those up regardless of outcome.
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	if !isMP3(header.Filename, header.Header.Get("Content-Type")) {
		httpError(w, http.StatusUnsupportedMediaType, "only mp3 uploads are supported")
		return
	}

	tmp, err := os.CreateTemp("", "music-upload-*.mp3")
	if err != nil {
		serverError(w, "temp file", err)
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
		serverError(w, "dedupe check", err)
		return
	} else if existing != nil {
		writeJSONStatus(w, http.StatusOK, existing)
		return
	}

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		serverError(w, "seek", err)
		return
	}
	tags, _ := metadata.Parse(tmp) // tag/duration issues are non-fatal

	newID := library.NewID()
	relPath := "songs/" + newID + ".mp3"
	dst, err := h.media.Create(relPath)
	if err != nil {
		serverError(w, "store file", err)
		return
	}
	// Remove the freshly-created media file unless the whole import succeeds,
	// so a later failure never leaves an orphaned file the DB doesn't reference.
	stored := false
	defer func() {
		if !stored {
			_ = h.media.Remove(relPath)
		}
	}()
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		dst.Close()
		serverError(w, "seek", err)
		return
	}
	if _, err := io.Copy(dst, tmp); err != nil {
		dst.Close()
		serverError(w, "write file", err)
		return
	}
	if err := dst.Close(); err != nil {
		serverError(w, "close file", err)
		return
	}

	title := tags.Title
	if title == "" {
		title = strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename))
	}
	// Songs with no year tag fall back to the current year, so an imported song
	// always has a year rather than a NULL.
	year := tags.Year
	if year == 0 {
		year = time.Now().Year()
	}
	// The stored title is left exactly as tagged; the DB is the source of truth and
	// duplicate artist+title rows are allowed to coexist as-is.
	song, err := h.repo.Create(r.Context(), newID, library.CreateSongParams{
		Title:       title,
		ArtistName:  tags.Artist,
		Album:       tags.Album,
		Year:        year,
		TrackNo:     tags.TrackNo,
		DurationMS:  tags.DurationMS,
		FileSize:    size,
		FilePath:    relPath,
		ContentHash: hash,
		Genres:      tags.Genres,
		Lyrics:      tags.Lyrics,
	})
	if err != nil {
		// A concurrent upload of the same bytes can slip in between our dedupe
		// check and this insert, tripping the content_hash unique index. Treat
		// it as a dedupe hit and return the winner's song rather than a 500.
		if existing, findErr := h.repo.FindByContentHash(r.Context(), hash); findErr == nil && existing != nil {
			writeJSONStatus(w, http.StatusOK, existing)
			return
		}
		serverError(w, "save song", err)
		return
	}
	stored = true
	// Import embedded cover art (APIC) so a well-tagged file keeps its own art
	// instead of a blank placeholder. Best-effort — any failure (unsupported image,
	// storage error) logs and leaves the song coverless; never fail the upload.
	// Only import when the track has no cover yet: Create already inherits the
	// album's existing cover (album_covers), so this must not clobber a cover the
	// user set manually or an earlier track established — first-with-art wins.
	if len(tags.CoverBytes) > 0 && song.CoverArtID == "" {
		if coverID, cerr := storeCoverBytes(r.Context(), h.media, h.repo, tags.CoverBytes); cerr != nil {
			slog.Warn("cover: embedded art import failed", "song", song.ID, "err", cerr)
		} else if err := h.repo.SetSongCover(r.Context(), song.ID, coverID); err != nil {
			slog.Warn("cover: embedded art assign failed", "song", song.ID, "err", err)
		} else {
			song.CoverArtID = coverID
		}
	}
	// Karaoke: a freshly imported file that already carries lyrics gets aligned in
	// the background (best-effort; never fail the upload). Files without embedded
	// lyrics are not aligned — alignment is meaningless without words.
	if strings.TrimSpace(tags.Lyrics) != "" {
		if _, err := h.enqueueAlignment(r.Context(), song.ID, song.FilePath, tags.Lyrics); err != nil {
			slog.Warn("karaoke: import alignment enqueue failed", "song", song.ID, "err", err)
		}
	}
	writeJSONStatus(w, http.StatusCreated, song)
}

func (h *songHandlers) publish(w http.ResponseWriter, r *http.Request)   { h.setPublished(w, r, true) }
func (h *songHandlers) unpublish(w http.ResponseWriter, r *http.Request) { h.setPublished(w, r, false) }

// setPublished flips a song's publish state. Authenticated-only (mirrors upload);
// returns the updated song, or 404 when the id is unknown.
func (h *songHandlers) setPublished(w http.ResponseWriter, r *http.Request, published bool) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	song, err := h.repo.SetPublished(r.Context(), r.PathValue("id"), published)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "set published")
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, song)
}

func (h *songHandlers) stream(w http.ResponseWriter, r *http.Request)   { h.serveFile(w, r, false) }
func (h *songHandlers) download(w http.ResponseWriter, r *http.Request) { h.serveFile(w, r, true) }

func (h *songHandlers) serveFile(w http.ResponseWriter, r *http.Request, attach bool) {
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	// An unpublished song must not stream or download for anonymous callers,
	// even when the id is known (e.g. a shared link) — 404 to avoid leaking
	// existence.
	if song == nil || (!song.Published && !identify(h.cfg, r).Authenticated) {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")

	if !attach {
		// Player/stream: serve the stored bytes as-is so HTTP range/seek stays cheap.
		// The player never reads embedded tags, so there's nothing to stamp.
		f, err := h.media.Open(song.FilePath)
		if err != nil {
			httpError(w, http.StatusNotFound, "audio file missing")
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			serverError(w, "stat file", err)
			return
		}
		http.ServeContent(w, r, song.ID+".mp3", info.ModTime(), f)
		return
	}

	// Download/export: the DB is the source of truth for tags, so bake the current
	// tags into a throwaway copy and serve that. The stored file is never mutated.
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", downloadName(song)))
	if srcAbs, err := h.media.Resolve(song.FilePath); err == nil {
		if tmpName, err := stampToTemp(srcAbs, h.songTags(r.Context(), song)); err == nil {
			defer os.Remove(tmpName)
			if f, err := os.Open(tmpName); err == nil {
				defer f.Close()
				if info, err := f.Stat(); err == nil {
					http.ServeContent(w, r, song.ID+".mp3", info.ModTime(), f)
					return
				}
			}
		} else {
			// Stamping can fail on a file id3v2 can't parse (upload validation is
			// loose). Never fail the download for that — fall back to the raw bytes.
			slog.Warn("download tag stamp failed; serving stored file as-is", "song", song.ID, "err", err)
		}
	}
	// Fallback: serve the stored file unmodified (also covers a missing/unsafe path,
	// which surfaces as 404 here just as it did before stamping existed).
	f, err := h.media.Open(song.FilePath)
	if err != nil {
		httpError(w, http.StatusNotFound, "audio file missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		serverError(w, "stat file", err)
		return
	}
	http.ServeContent(w, r, song.ID+".mp3", info.ModTime(), f)
}

// stampToTemp copies the stored file at srcAbs into a fresh temp file with the given
// tags baked in and returns the temp path; the caller owns its removal. On error the
// temp file is cleaned up so no orphan is left behind.
func stampToTemp(srcAbs string, t metadata.WriteableTags) (string, error) {
	tmp, err := os.CreateTemp("", "music-download-*.mp3")
	if err != nil {
		return "", err
	}
	name := tmp.Name()
	tmp.Close()
	if err := metadata.StampTags(srcAbs, name, t); err != nil {
		os.Remove(name)
		return "", err
	}
	return name, nil
}

// songTags maps a stored song's authoritative DB metadata to the writeable tag set
// baked into a download, including the mapped cover art embedded as the front-cover
// picture. Resolving the cover is best-effort: any failure leaves the cover fields
// empty so the download still succeeds (WriteTags then preserves existing art).
func (h *songHandlers) songTags(ctx context.Context, s *library.Song) metadata.WriteableTags {
	t := metadata.WriteableTags{
		Title:   s.Title,
		Artist:  s.ArtistName,
		Album:   s.Album,
		Year:    s.Year,
		TrackNo: s.TrackNo,
		Genres:  displayGenres(s.Genres),
		Lyrics:  s.Lyrics,
	}
	// Karaoke: bake word timings into a SYLT frame when the song is aligned. Best
	// effort — any failure just omits SYLT so the download still succeeds.
	if a, err := h.repo.GetAlignment(ctx, s.ID); err == nil && a != nil && a.Status == "ready" {
		if words := syltWords(a.Data); len(words) > 0 {
			t.Synced = words
		}
	}
	if s.CoverArtID == "" {
		return t
	}
	relPath, err := h.repo.GetCoverPath(ctx, s.CoverArtID)
	if err != nil || relPath == "" {
		return t
	}
	data, err := readMediaBytes(h.media, relPath)
	if err != nil || len(data) == 0 {
		return t
	}
	t.CoverBytes = data
	t.CoverMIME = imagegen.MIMEType(filepath.Ext(relPath))
	return t
}

// displayGenres title-cases the stored (lowercase) genres so a downloaded file's
// ID3 tag reads the same as the UI ("r&b" → "R&B"), rather than the raw canonical
// form. Returns a fresh slice so the song's own genres are never mutated.
func displayGenres(genres []string) []string {
	if len(genres) == 0 {
		return genres
	}
	out := make([]string, len(genres))
	for i, g := range genres {
		out[i] = library.GenreDisplay(g)
	}
	return out
}

// syltWords flattens stored alignment line JSON into SYLT sync entries, one per
// word, prefixing each line's first word with "\n" so players render line breaks
// and every later word with a space so the line reads naturally.
func syltWords(data string) []metadata.SyncedWord {
	var lines []align.Line
	if err := json.Unmarshal([]byte(data), &lines); err != nil {
		return nil
	}
	var out []metadata.SyncedWord
	for _, ln := range lines {
		for i, wd := range ln.Words {
			text := " " + wd.W
			if i == 0 {
				text = "\n" + wd.W
			}
			out = append(out, metadata.SyncedWord{Text: text, TimeMs: uint32(wd.Start * 1000)})
		}
	}
	return out
}

func isMP3(filename, contentType string) bool {
	if strings.EqualFold(filepath.Ext(filename), ".mp3") {
		return true
	}
	return contentType == "audio/mpeg" || contentType == "audio/mp3"
}

// downloadBase is the filename stem shared by every per-song download ("Artist -
// Title", sanitized of path/shell-hostile runes, song ID as a last resort). The
// caller appends the extension for the flavour it serves.
func downloadBase(s *library.Song) string {
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
	return base
}

func downloadName(s *library.Song) string {
	return downloadBase(s) + ".mp3"
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// serverError logs the underlying cause and returns a 500 to the client with a
// generic message. The cause is server-side only (never leaked to the client);
// msg doubles as the log event name and the client-facing error string.
func serverError(w http.ResponseWriter, msg string, err error) {
	slog.Error(msg, "err", err)
	httpError(w, http.StatusInternalServerError, msg)
}

func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
