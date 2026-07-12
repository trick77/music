package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/trick77/music/internal/imageutil"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
)

// bufferProbeImage buffers the multipart "file", hashes it, validates it as an
// image, and rewinds the temp file to the start. On any failure it writes the
// HTTP error itself and returns ok=false, so callers can simply `return`. When
// ok is true the caller owns the returned *os.File and must
// `os.Remove(tmp.Name())` + `tmp.Close()`.
func bufferProbeImage(w http.ResponseWriter, r *http.Request, maxBytes int64) (*os.File, string, int, int, string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpError(w, http.StatusRequestEntityTooLarge, "image exceeds size limit")
			return nil, "", 0, 0, "", false
		}
		httpError(w, http.StatusBadRequest, "missing file field")
		return nil, "", 0, 0, "", false
	}
	defer file.Close()
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	tmp, err := os.CreateTemp("", "music-image-*")
	if err != nil {
		serverError(w, "temp file", err)
		return nil, "", 0, 0, "", false
	}
	cleanup := func() { _ = os.Remove(tmp.Name()); _ = tmp.Close() }

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), file); err != nil {
		cleanup()
		httpError(w, http.StatusBadRequest, "read upload")
		return nil, "", 0, 0, "", false
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		serverError(w, "seek", err)
		return nil, "", 0, 0, "", false
	}
	width, height, ext, err := imageutil.Probe(tmp)
	if err != nil {
		cleanup()
		httpError(w, http.StatusUnsupportedMediaType, "unsupported image format")
		return nil, "", 0, 0, "", false
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		serverError(w, "seek", err)
		return nil, "", 0, 0, "", false
	}
	return tmp, hash, width, height, ext, true
}

// storeUploadedCover buffers/validates the multipart "file", dedupes by content
// hash, and stores new bytes under covers/. It returns the cover_art id. On any
// failure it writes the HTTP error itself and returns ok=false.
func storeUploadedCover(w http.ResponseWriter, r *http.Request, store *media.Store, repo *library.Repo, maxBytes int64) (string, bool) {
	tmp, hash, width, height, ext, ok := bufferProbeImage(w, r, maxBytes)
	if !ok {
		return "", false
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	coverID, _, err := repo.FindCoverByHash(r.Context(), hash)
	if err != nil {
		serverError(w, "cover lookup", err)
		return "", false
	}
	if coverID != "" {
		return coverID, true
	}

	relPath := "covers/" + hash + "." + ext
	dst, err := store.Create(relPath)
	if err != nil {
		serverError(w, "store cover", err)
		return "", false
	}
	if _, err := io.Copy(dst, tmp); err != nil {
		dst.Close()
		serverError(w, "write cover", err)
		return "", false
	}
	if err := dst.Close(); err != nil {
		serverError(w, "close cover", err)
		return "", false
	}
	coverID, err = repo.CreateCover(r.Context(), library.CoverParams{
		ImagePath: relPath, Width: width, Height: height, ContentHash: hash,
	})
	if err != nil {
		_ = store.Remove(relPath)
		serverError(w, "save cover", err)
		return "", false
	}
	return coverID, true
}

// storeCoverBytes validates image bytes, dedupes by content hash, stores new
// bytes under covers/, and returns the cover_art id. Unlike storeUploadedCover
// it writes no HTTP response, so non-HTTP callers (embedded-cover import on
// upload) can reuse it. Rejects bytes that aren't a supported image.
func storeCoverBytes(ctx context.Context, store *media.Store, repo *library.Repo, data []byte) (string, error) {
	width, height, ext, err := imageutil.Probe(bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])

	// Store the bytes only if this content is new (CreateCover dedupes by hash,
	// but the file must exist on disk for a fresh hash).
	relPath := "covers/" + hash + "." + ext
	if existingID, _, herr := repo.FindCoverByHash(ctx, hash); herr != nil {
		return "", herr
	} else if existingID == "" {
		if werr := writeBytes(store, relPath, data); werr != nil {
			return "", werr
		}
	}
	coverID, err := repo.CreateCover(ctx, library.CoverParams{
		ImagePath: relPath, Width: width, Height: height, ContentHash: hash,
	})
	if err != nil {
		_ = store.Remove(relPath)
		return "", err
	}
	return coverID, nil
}
