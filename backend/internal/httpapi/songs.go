package httpapi

import (
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

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/metadata"
)

type songHandlers struct {
	cfg      config.Config
	repo     *library.Repo
	media    *media.Store
	maxBytes int64

	imageGen      imagegen.Provider
	bflModel      string
	onGenComplete func(id string)

	throttle *playThrottle
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
