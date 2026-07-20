package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

type promptTS struct {
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

// newPromptServer builds an authed (dev) and anonymous (oidc) handler over one
// store with a fake genre prompter wired in, so the suggest/refine routes are
// registered but no live LLM call is ever made. A nil gp leaves them
// unconfigured (404). Also seeds one genre row ("g-jazz").
func newPromptServer(t *testing.T, gp *fakeGenrePrompter) *promptTS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.DB().ExecContext(context.Background(),
		`INSERT INTO genres(id,name) VALUES('g-jazz','Jazz')`); err != nil {
		t.Fatalf("seed genre: %v", err)
	}
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: 50,
		}
		if gp == nil {
			return NewWithProvider(cfg, st, spa, nil, nil)
		}
		return NewWithGenrePrompter(cfg, st, spa, nil, nil, gp)
	}
	return &promptTS{dev: mk(config.AuthModeDev), anon: mk(config.AuthModeOIDC), repo: library.NewRepo(st.DB())}
}

// postRaw posts a literal body (used for malformed-JSON cases postJSON cannot
// express).
func postRaw(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// --- genre refine-prompt ---

func TestGenreRefinePrompt_gating(t *testing.T) {
	for _, tc := range []struct {
		name string
		gp   *fakeGenrePrompter
		auth bool
		path string
		want int
	}{
		{"anonymous is 403", &fakeGenrePrompter{prompt: "x"}, false, "/api/genres/g-jazz/refine-prompt", http.StatusForbidden},
		{"unconfigured is 404", nil, true, "/api/genres/g-jazz/refine-prompt", http.StatusNotFound},
		{"unknown genre is 404", &fakeGenrePrompter{prompt: "x"}, true, "/api/genres/nope/refine-prompt", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts := newPromptServer(t, tc.gp)
			h := ts.anon
			if tc.auth {
				h = ts.dev
			}
			rr := postJSON(t, h, tc.path, map[string]any{"prompt": "a skyline", "instruction": "more neon"})
			if rr.Code != tc.want {
				t.Fatalf("code = %d, want %d (body %s)", rr.Code, tc.want, rr.Body)
			}
		})
	}
}

func TestGenreRefinePrompt_badRequests(t *testing.T) {
	ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
	t.Run("malformed JSON", func(t *testing.T) {
		rr := postRaw(t, ts.dev, "/api/genres/g-jazz/refine-prompt", `{"prompt":`)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rr.Code)
		}
	})
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"missing prompt", map[string]any{"instruction": "more neon"}},
		{"blank prompt", map[string]any{"prompt": "   ", "instruction": "more neon"}},
		{"missing instruction", map[string]any{"prompt": "a skyline"}},
		{"blank instruction", map[string]any{"prompt": "a skyline", "instruction": " "}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := postJSON(t, ts.dev, "/api/genres/g-jazz/refine-prompt", tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
			}
		})
	}
}

func TestGenreRefinePrompt_happyPath(t *testing.T) {
	ts := newPromptServer(t, &fakeGenrePrompter{prompt: "a smoky jazz club, now drenched in neon"})
	rr := postJSON(t, ts.dev, "/api/genres/g-jazz/refine-prompt", map[string]any{
		"prompt": "a smoky jazz club", "instruction": "more neon",
	})
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, body %s", rr.Code, rr.Body)
	}
	var out struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(out.Prompt, "neon") {
		t.Fatalf("prompt = %q, want the refined text", out.Prompt)
	}
}

// An LLM failure must surface as a 500 without leaking the upstream message.
func TestGenreRefinePrompt_prompterErrorIs500(t *testing.T) {
	ts := newPromptServer(t, &fakeGenrePrompter{err: errors.New("upstream rate limit hit")})
	rr := postJSON(t, ts.dev, "/api/genres/g-jazz/refine-prompt", map[string]any{
		"prompt": "a skyline", "instruction": "more neon",
	})
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", rr.Code)
	}
	if strings.Contains(rr.Body.String(), "rate limit") {
		t.Fatalf("leaked upstream detail: %s", rr.Body)
	}
}

// --- album refine-prompt ---

func TestAlbumRefinePrompt_gating(t *testing.T) {
	body := map[string]any{"prompt": "a skyline", "instruction": "more neon"}
	t.Run("anonymous is 403", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		if rr := postJSON(t, ts.anon, "/api/albums/refine-prompt", body); rr.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rr.Code)
		}
	})
	t.Run("unconfigured is 404", func(t *testing.T) {
		ts := newPromptServer(t, nil)
		if rr := postJSON(t, ts.dev, "/api/albums/refine-prompt", body); rr.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", rr.Code)
		}
	})
	t.Run("malformed JSON is 400", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		if rr := postRaw(t, ts.dev, "/api/albums/refine-prompt", `{`); rr.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rr.Code)
		}
	})
	t.Run("missing instruction is 400", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		rr := postJSON(t, ts.dev, "/api/albums/refine-prompt", map[string]any{"prompt": "a skyline"})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rr.Code)
		}
	})
}

// The album grounding is best-effort: an unknown album still refines (no
// album-exists gate), and a known album is accepted just the same.
func TestAlbumRefinePrompt_refinesWithAndWithoutKnownAlbum(t *testing.T) {
	ts := newPromptServer(t, &fakeGenrePrompter{prompt: "a neon skyline, saturated"})
	song := mkAlbumSong(t, ts.repo, "One", "Neon Nights", "h1", "songs/a.mp3")

	for _, tc := range []struct {
		name     string
		artistID string
		album    string
	}{
		{"known album", song.ArtistID, "neon nights"},
		{"unknown album", "no-such-artist", "Ghost"},
		{"no album reference", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := postJSON(t, ts.dev, "/api/albums/refine-prompt", map[string]any{
				"prompt": "a skyline", "instruction": "more neon",
				"artistId": tc.artistID, "album": tc.album,
			})
			if rr.Code != http.StatusOK {
				t.Fatalf("code = %d, body %s", rr.Code, rr.Body)
			}
			var out struct {
				Prompt string `json:"prompt"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil || out.Prompt == "" {
				t.Fatalf("bad response %s (%v)", rr.Body, err)
			}
		})
	}
}

// --- album suggest-prompt ---

func TestAlbumSuggestPrompt(t *testing.T) {
	t.Run("anonymous is 403", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		rr := postJSON(t, ts.anon, "/api/albums/suggest-prompt", map[string]any{"artistId": "a", "album": "b"})
		if rr.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rr.Code)
		}
	})
	t.Run("unconfigured is 404", func(t *testing.T) {
		ts := newPromptServer(t, nil)
		rr := postJSON(t, ts.dev, "/api/albums/suggest-prompt", map[string]any{"artistId": "a", "album": "b"})
		if rr.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", rr.Code)
		}
	})
	t.Run("malformed JSON is 400", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		if rr := postRaw(t, ts.dev, "/api/albums/suggest-prompt", `nope`); rr.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rr.Code)
		}
	})
	t.Run("unknown album is 404", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
		rr := postJSON(t, ts.dev, "/api/albums/suggest-prompt", map[string]any{"artistId": "ghost", "album": "Nope"})
		if rr.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", rr.Code)
		}
	})
	t.Run("known album returns a prompt", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{prompt: "a neon skyline album cover"})
		song := mkAlbumSong(t, ts.repo, "One", "Neon Nights", "h1", "songs/a.mp3")
		rr := postJSON(t, ts.dev, "/api/albums/suggest-prompt", map[string]any{
			"artistId": song.ArtistID, "album": "neon nights", // case-insensitive lookup
		})
		if rr.Code != http.StatusOK {
			t.Fatalf("code = %d, body %s", rr.Code, rr.Body)
		}
		var out struct {
			Prompt string `json:"prompt"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil || out.Prompt == "" {
			t.Fatalf("bad response %s (%v)", rr.Body, err)
		}
	})
	t.Run("prompter error is 500", func(t *testing.T) {
		ts := newPromptServer(t, &fakeGenrePrompter{err: errors.New("upstream boom")})
		song := mkAlbumSong(t, ts.repo, "One", "Neon Nights", "h1", "songs/a.mp3")
		rr := postJSON(t, ts.dev, "/api/albums/suggest-prompt", map[string]any{
			"artistId": song.ArtistID, "album": "Neon Nights",
		})
		if rr.Code != http.StatusInternalServerError {
			t.Fatalf("code = %d, want 500", rr.Code)
		}
		if strings.Contains(rr.Body.String(), "boom") {
			t.Fatalf("leaked upstream detail: %s", rr.Body)
		}
	})
}

// listAlbums is a Studio surface: authed callers see the library's albums,
// anonymous callers are refused outright.
func TestListAlbums_authGated(t *testing.T) {
	ts := newPromptServer(t, &fakeGenrePrompter{prompt: "x"})
	mkAlbumSong(t, ts.repo, "One", "Neon Nights", "h1", "songs/a.mp3")

	anon := httptest.NewRecorder()
	ts.anon.ServeHTTP(anon, httptest.NewRequest("GET", "/api/albums", nil))
	if anon.Code != http.StatusForbidden {
		t.Fatalf("anonymous list albums = %d, want 403", anon.Code)
	}

	dev := httptest.NewRecorder()
	ts.dev.ServeHTTP(dev, httptest.NewRequest("GET", "/api/albums", nil))
	if dev.Code != http.StatusOK {
		t.Fatalf("dev list albums = %d, want 200", dev.Code)
	}
	var out struct {
		Albums []library.AlbumSummary `json:"albums"`
	}
	if err := json.Unmarshal(dev.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Albums) != 1 || out.Albums[0].Album != "Neon Nights" {
		t.Fatalf("albums = %+v", out.Albums)
	}
}
