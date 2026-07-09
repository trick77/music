package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
		if errors.As(err, &tooLarge) {
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
	coverID, _, err := h.repo.FindCoverByHash(r.Context(), hash)
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
