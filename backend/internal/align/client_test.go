package align

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAlign_postsMultipartAndParsesResult(t *testing.T) {
	var gotLyrics, gotAudio string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/align" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		gotLyrics = r.FormValue("lyrics")
		f, _, _ := r.FormFile("audio")
		b, _ := io.ReadAll(f)
		gotAudio = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"engine":"whisperx+demucs","lines":[{"text":"hi there","start":1.0,"end":2.0,"words":[{"w":"hi","start":1.0,"end":1.4,"conf":0.9},{"w":"there","start":1.5,"end":2.0,"conf":0.8}]}]}`)
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	res, err := c.Align(context.Background(), strings.NewReader("AUDIOBYTES"), "song.mp3", "hi there")
	if err != nil {
		t.Fatalf("Align: %v", err)
	}
	if gotLyrics != "hi there" || gotAudio != "AUDIOBYTES" {
		t.Fatalf("sidecar got lyrics=%q audio=%q", gotLyrics, gotAudio)
	}
	if res.Engine != "whisperx+demucs" || len(res.Lines) != 1 || len(res.Lines[0].Words) != 2 {
		t.Fatalf("parsed result wrong: %+v", res)
	}
	if res.Lines[0].Words[0].W != "hi" || res.Lines[0].Words[1].End != 2.0 {
		t.Fatalf("word parse wrong: %+v", res.Lines[0].Words)
	}
}

func TestAlign_nonJSONErrorSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":"model not loaded"}`)
	}))
	defer srv.Close()
	c := New(srv.URL, 5*time.Second)
	_, err := c.Align(context.Background(), strings.NewReader("x"), "s.mp3", "hi")
	if err == nil || !strings.Contains(err.Error(), "model not loaded") {
		t.Fatalf("want error containing sidecar reason, got %v", err)
	}
}
