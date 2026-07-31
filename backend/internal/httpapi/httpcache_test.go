package httpapi

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestETagMatch(t *testing.T) {
	const etag = `"abc"`
	for _, tc := range []struct {
		name, header string
		want         bool
	}{
		{"empty", "", false},
		{"exact", `"abc"`, true},
		{"list", `"zzz", "abc"`, true},
		{"weak prefix on the client copy", `W/"abc"`, true},
		{"star", "*", true},
		{"different", `"def"`, false},
		{"substring is not a match", `"abcd"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := etagMatch(tc.header, etag); got != tc.want {
				t.Errorf("etagMatch(%q, %q) = %v, want %v", tc.header, etag, got, tc.want)
			}
		})
	}
}

// A handler that flushes wants its bytes on the wire immediately. Buffering it to
// compute an ETag would stall a stream forever, so the first Flush must abandon
// buffering and hand over everything written so far.
func TestWithJSONETag_flushingHandlerStreams(t *testing.T) {
	h := withJSONETag(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"first":1}`))
		w.(http.Flusher).Flush()
		w.Write([]byte(`{"second":2}`))
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/anything", nil))

	if rr.Header().Get("ETag") != "" {
		t.Error("streamed response was given an ETag; it was buffered after all")
	}
	if body := rr.Body.String(); !strings.Contains(body, `"first"`) || !strings.Contains(body, `"second"`) {
		t.Errorf("streamed body lost writes: %q", body)
	}
}

// Past the buffer cap the response streams out rather than growing without bound,
// and every byte still has to arrive.
func TestWithJSONETag_oversizedBodyPassesThrough(t *testing.T) {
	chunk := strings.Repeat("x", 1<<20)
	const chunks = 9 // 9 MiB, past etagBufferLimit
	h := withJSONETag(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i < chunks; i++ {
			w.Write([]byte(chunk))
		}
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/anything", nil))

	if rr.Header().Get("ETag") != "" {
		t.Error("oversized response was given an ETag")
	}
	if got, want := rr.Body.Len(), chunks<<20; got != want {
		t.Errorf("body = %d bytes, want %d", got, want)
	}
}

// A handler that sets its own Cache-Control keeps it — the wrapper adds a
// validator, it does not overrule a policy the handler chose deliberately.
func TestWithJSONETag_keepsHandlerCacheControl(t *testing.T) {
	h := withJSONETag(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=60")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/anything", nil))

	if got := rr.Header().Get("Cache-Control"); got != "public, max-age=60" {
		t.Errorf("Cache-Control = %q, want the handler's own", got)
	}
	if rr.Header().Get("ETag") == "" {
		t.Error("no ETag added")
	}
}

// Past the buffer cap the body loses its validator, but not its audience: it is
// still a session-dependent JSON read, so it must stay marked private or a shared
// cache could hand one caller's copy to the next.
func TestWithJSONETag_oversizedBodyStaysPrivate(t *testing.T) {
	chunk := strings.Repeat("x", 1<<20)
	h := withJSONETag(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i < 9; i++ {
			w.Write([]byte(chunk))
		}
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/anything", nil))

	if got := rr.Header().Get("Cache-Control"); got != revalidateCache {
		t.Errorf("Cache-Control = %q, want %q", got, revalidateCache)
	}
	if got := rr.Header().Get("Vary"); !strings.Contains(got, "Cookie") {
		t.Errorf("Vary = %q, want it to include Cookie", got)
	}
}

// httptest.NewRecorder tolerates a double WriteHeader; a real server logs
// "superfluous response.WriteHeader call" for each one. This wrapper sits in
// front of every image, stream and error response, so writing the header twice
// puts a line in the log for every one of them. Only a real server catches it.
func TestWithJSONETag_doesNotWriteHeaderTwice(t *testing.T) {
	for _, tc := range []struct {
		name string
		fn   http.HandlerFunc
	}{
		{"error", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"error":"nope"}`))
		}},
		{"image", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "image/jpeg")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("\xff\xd8\xff"))
		}},
		{"json", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true}`))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logged bytes.Buffer
			srv := httptest.NewUnstartedServer(withJSONETag(tc.fn))
			srv.Config.ErrorLog = log.New(&logged, "", 0)
			srv.Start()
			defer srv.Close()

			resp, err := http.Get(srv.URL + "/api/anything")
			if err != nil {
				t.Fatalf("GET: %v", err)
			}
			resp.Body.Close()
			if logged.Len() != 0 {
				t.Errorf("server logged %q", logged.String())
			}
		})
	}
}
