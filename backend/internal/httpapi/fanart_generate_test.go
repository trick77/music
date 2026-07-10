package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/imagegen"
)

type fakeProvider struct {
	result imagegen.GenerateResult
	err    error
}

func (f fakeProvider) Generate(context.Context, imagegen.GenerateRequest) (imagegen.GenerateResult, error) {
	return f.result, f.err
}

func newFanartTestServerWithGen(t *testing.T, gen imagegen.Provider, onGen func(string)) *fanartTS {
	return newFanartServer(t, gen, onGen)
}

func (ts *fanartTS) generate(t *testing.T, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/fanart/generate", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, req)
	return rr
}

func TestGenerate_generatingThenReady(t *testing.T) {
	done := make(chan string, 1)
	ts := newFanartTestServerWithGen(t, fakeProvider{
		result: imagegen.GenerateResult{Bytes: pngBytes(t, 1344, 768), MIMEType: "image/png", Extension: "png"},
	}, func(id string) { done <- id })
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "a smoky club", "kind": "genre", "genreId": genreID})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	id := ts.idFromResponse(t, rec)
	if strings.Contains(rec.Body.String(), "smoky club") {
		t.Fatalf("generate response leaked prompt: %s", rec.Body)
	}
	<-done // goroutine finished
	body := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true)
	if !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("status not ready: %s", body)
	}
}

func TestGenerate_moderatedBecomesFailed(t *testing.T) {
	done := make(chan string, 1)
	ts := newFanartTestServerWithGen(t, fakeProvider{err: errors.New("BFL blocked the prompt (request moderated)")},
		func(id string) { done <- id })
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "x", "kind": "genre", "genreId": genreID})
	id := ts.idFromResponse(t, rec)
	<-done
	if !strings.Contains(ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true), `"status":"failed"`) {
		t.Fatal("expected failed status for authed meta")
	}
	if strings.Contains(ts.getJSON(t, "/api/fanart/"+id+"?meta=1", false), "moderated") {
		t.Fatal("anonymous meta leaked moderation text")
	}
}

func TestGenerate_disabledWhenNoKey(t *testing.T) {
	ts := newFanartTestServer(t) // no Provider wired
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.generate(t, map[string]any{"prompt": "x", "kind": "genre", "genreId": genreID})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 when generation disabled", rec.Code)
	}
}
