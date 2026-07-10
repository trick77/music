package httpapi

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"time"

	"github.com/trick77/music/internal/imagescale"
	"github.com/trick77/music/internal/media"
)

// imageSizes maps a ?size= name to the longest-side pixel bound of the variant.
var imageSizes = map[string]int{"thumb": 160, "card": 480, "hero": 1600}

// sizeParam resolves the ?size= query. An empty or unrecognized value serves the
// original (ok=false).
func sizeParam(r *http.Request) (int, string, bool) {
	name := r.URL.Query().Get("size")
	if dim, ok := imageSizes[name]; ok {
		return dim, name, true
	}
	return 0, "", false
}

// serveSizedImage serves relPath from the media store. With ?size=thumb|card|hero
// it serves (and caches on the volume) a downscaled JPEG variant; otherwise it
// serves the original bytes. All paths stay sandboxed via media.Store.
func serveSizedImage(w http.ResponseWriter, r *http.Request, store *media.Store, relPath string) {
	dim, name, sized := sizeParam(r)
	if !sized {
		serveStoreFile(w, r, store, relPath)
		return
	}
	cacheRel := relPath + "." + name + ".jpg"
	if f, err := store.Open(cacheRel); err == nil {
		defer f.Close()
		if info, err := f.Stat(); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			http.ServeContent(w, r, filepath.Base(cacheRel), info.ModTime(), f)
			return
		}
	}
	// Build the variant from the original.
	src, err := store.Open(relPath)
	if err != nil {
		httpError(w, http.StatusNotFound, "image missing")
		return
	}
	data, err := io.ReadAll(src)
	src.Close()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "read image")
		return
	}
	scaled, err := imagescale.Thumbnail(data, dim)
	if err != nil {
		// Undecodable as raster: fall back to the original bytes.
		serveStoreFile(w, r, store, relPath)
		return
	}
	if dst, err := store.Create(cacheRel); err == nil { // best-effort cache write
		_, _ = dst.Write(scaled)
		_ = dst.Close()
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, filepath.Base(cacheRel), time.Time{}, bytes.NewReader(scaled))
}

// serveStoreFile serves the original bytes at relPath with a content type derived
// from its extension.
func serveStoreFile(w http.ResponseWriter, r *http.Request, store *media.Store, relPath string) {
	f, err := store.Open(relPath)
	if err != nil {
		httpError(w, http.StatusNotFound, "image missing")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "stat image")
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(relPath)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, filepath.Base(relPath), info.ModTime(), f)
}

// writeStoreFile copies src into relPath under the store.
func writeStoreFile(store *media.Store, relPath string, src io.Reader) error {
	dst, err := store.Create(relPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	return dst.Close()
}

// writeBytes writes b into relPath under the store.
func writeBytes(store *media.Store, relPath string, b []byte) error {
	return writeStoreFile(store, relPath, bytes.NewReader(b))
}
