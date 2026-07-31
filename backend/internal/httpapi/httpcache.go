package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// immutableCache is the Cache-Control for a URL whose bytes can never change.
//
// Every image the API serves is content-addressed in that sense: a cover id is
// looked up by content hash (storeUploadedCover dedupes on it), and a fanart /
// studio-cover-art row is written once — its image_path is set exactly once when
// generation finishes and never rewritten. A different image therefore always
// means a different id, i.e. a different URL, so a client can hold these forever
// and never see stale art. This is what stops a scrolled-back rail from
// refetching hundreds of thumbnails on every visit.
const immutableCache = "public, max-age=31536000, immutable"

// revalidateCache stores the response but forces a conditional request before
// reuse. Used for anything whose URL stays put while its bytes may change (JSON
// reads, the audio stream): the client still pays a round trip, but a 304 costs
// headers instead of the whole body.
//
// "private" because most API reads differ per session (identify() decides what an
// anonymous caller sees), so no shared cache may hold one caller's copy for
// another.
const revalidateCache = "private, no-cache"

// privateImmutableCache is immutableCache for an authentication-gated URL. The
// bytes never change, so the caller may hold them forever, but "public" would
// invite a shared cache to hand an authed-only image to an anonymous visitor.
const privateImmutableCache = "private, max-age=31536000, immutable"

// setImmutable marks a response as permanently cacheable. Call it only for a URL
// that is content-addressed by construction (see immutableCache) — never for a
// URL that resolves through a mutable pointer, such as a song's current cover.
func setImmutable(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", immutableCache)
}

// setPrivateImmutable is setImmutable for a route behind an auth check.
func setPrivateImmutable(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", privateImmutableCache)
}

// setRevalidate marks a response as store-and-revalidate: the URL stays put while
// its bytes may change, so the client must ask before reusing its copy.
func setRevalidate(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", revalidateCache)
}

// setNoStore forbids caching entirely. Errors get this: a 404 with no
// Cache-Control is *heuristically* cacheable, so a browser may keep it — and
// "image not ready" answered while generation is still running would then hide
// the finished image for as long as the client chose to hold it.
func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

// setStreamValidators marks a stored file as store-and-revalidate and gives it a
// strong ETag over its size and modification time. http.ServeContent takes it
// from there: If-None-Match becomes a 304, and If-Range keeps a seek inside a
// half-downloaded track from silently splicing bytes of a replaced file.
func setStreamValidators(w http.ResponseWriter, mod time.Time, size int64) {
	w.Header().Set("Cache-Control", revalidateCache)
	w.Header().Set("ETag", fmt.Sprintf(`"%x-%x"`, mod.UnixNano(), size))
}

// etagMatch reports whether an If-None-Match header matches etag.
//
// The header is a comma-separated list and its members may carry the weak "W/"
// prefix, so a plain string compare would silently never match and every
// revalidation would return the full body. "*" matches any existing entity.
func etagMatch(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" || etag == "" {
		return false
	}
	for _, cand := range strings.Split(ifNoneMatch, ",") {
		cand = strings.TrimSpace(cand)
		if cand == "*" {
			return true
		}
		if strings.TrimPrefix(cand, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

// etagBufferLimit caps how much of a JSON response is held in memory to hash it.
// Beyond it the response streams out unvalidated rather than growing the buffer
// without bound; no read endpoint comes close today.
const etagBufferLimit = 8 << 20

// withJSONETag gives every JSON read response an ETag derived from its own bytes,
// so a client that already has the data revalidates into a 304 instead of
// refetching it.
//
// It only ever engages for GET/HEAD responses that turn out to be 200 with a JSON
// content type. Everything else — writes, errors, audio, images, SSE — passes
// straight through to the underlying writer, untouched and unbuffered.
func withJSONETag(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			next.ServeHTTP(w, r)
			return
		}
		cw := &condWriter{ResponseWriter: w, req: r}
		next.ServeHTTP(cw, r)
		cw.finish()
	})
}

// condWriter buffers a JSON body so it can be hashed into an ETag. It starts
// undecided and commits on the first write: JSON 200s are buffered, anything else
// switches to passthrough and is never touched again.
type condWriter struct {
	http.ResponseWriter
	req    *http.Request
	status int
	buf    []byte
	// decided is set once the first write picks buffering or passthrough;
	// buffering says which one it picked.
	decided   bool
	buffering bool
}

func (cw *condWriter) WriteHeader(code int) {
	if cw.decided {
		// Repeat call. Forward it while passing through, so a handler that really
		// does write the header twice still gets net/http's warning; swallow it
		// while buffering, where finish() owns the single WriteHeader.
		if !cw.buffering {
			cw.ResponseWriter.WriteHeader(code)
		}
		return
	}
	cw.status = code
	// decide() emits the header itself when it picks passthrough — calling
	// WriteHeader again here would make net/http log "superfluous
	// response.WriteHeader call" for every image, stream and error response.
	cw.decide()
}

func (cw *condWriter) Write(b []byte) (int, error) {
	cw.decide()
	if !cw.buffering {
		return cw.ResponseWriter.Write(b)
	}
	cw.buf = append(cw.buf, b...)
	if len(cw.buf) > etagBufferLimit {
		cw.passthrough()
	}
	return len(b), nil
}

// ReadFrom preserves net/http's sendfile fast path for the audio and image routes
// (http.ServeContent), which would otherwise fall back to a userspace copy once
// this wrapper is in the chain. Those responses are never JSON, so this always
// lands in passthrough.
func (cw *condWriter) ReadFrom(src io.Reader) (int64, error) {
	cw.decide()
	if cw.buffering {
		cw.passthrough()
	}
	if rf, ok := cw.ResponseWriter.(io.ReaderFrom); ok {
		return rf.ReadFrom(src)
	}
	return io.Copy(cw.ResponseWriter, src)
}

// Flush forwards flushes so streaming handlers keep working through the wrapper.
// A handler that flushes wants bytes on the wire now, which is the opposite of
// buffering, so this abandons buffering first.
func (cw *condWriter) Flush() {
	cw.decide()
	if cw.buffering {
		cw.passthrough()
	}
	if f, ok := cw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap exposes the underlying writer for http.ResponseController.
func (cw *condWriter) Unwrap() http.ResponseWriter {
	return cw.ResponseWriter
}

// decide commits to buffering or passthrough based on the headers the handler has
// set so far. Handlers commonly write a body without ever calling WriteHeader, so
// this must be reachable from Write, not only WriteHeader.
func (cw *condWriter) decide() {
	if cw.decided {
		return
	}
	cw.decided = true
	if cw.status == 0 {
		cw.status = http.StatusOK
	}
	ct := cw.Header().Get("Content-Type")
	cw.buffering = cw.status == http.StatusOK && strings.HasPrefix(ct, "application/json")
	if !cw.buffering {
		cw.ResponseWriter.WriteHeader(cw.status)
	}
}

// passthrough abandons buffering mid-response, emptying whatever was collected to
// the real writer first so no bytes are lost.
func (cw *condWriter) passthrough() {
	cw.buffering = false
	// This body is still a session-dependent JSON 200 — it just cannot carry a
	// validator any more. It must not lose the "private"/Vary marking the rest of
	// the JSON surface gets, or a shared cache could hold one caller's copy.
	h := cw.Header()
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", revalidateCache)
		h.Add("Vary", "Cookie")
	}
	cw.ResponseWriter.WriteHeader(cw.status)
	if len(cw.buf) > 0 {
		_, _ = cw.ResponseWriter.Write(cw.buf)
		cw.buf = nil
	}
}

// finish emits the buffered JSON body — as a 304 when the client's copy already
// matches, otherwise as the full response with its ETag attached.
func (cw *condWriter) finish() {
	if !cw.decided {
		// Handler wrote nothing at all; make sure a status still goes out.
		cw.decide()
	}
	if !cw.buffering {
		return
	}
	sum := sha256.Sum256(cw.buf)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	h := cw.Header()
	h.Set("ETag", etag)
	// Bodies differ by session (identify() gates what a caller sees), so a cache
	// keyed on the URL alone would be wrong.
	h.Add("Vary", "Cookie")
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", revalidateCache)
	}
	if etagMatch(cw.req.Header.Get("If-None-Match"), etag) {
		// A 304 carries no entity body; Go would otherwise announce a length it
		// never sends.
		h.Del("Content-Type")
		h.Del("Content-Length")
		cw.ResponseWriter.WriteHeader(http.StatusNotModified)
		return
	}
	cw.ResponseWriter.WriteHeader(cw.status)
	_, _ = cw.ResponseWriter.Write(cw.buf)
}
