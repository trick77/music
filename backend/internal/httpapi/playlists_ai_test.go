package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/internal/studio"
)

// fakeDescriptionWriter returns a fixed set of playlist tones without any live
// LLM call.
type fakeDescriptionWriter struct {
	tones studio.PlaylistTones
	err   error
}

func (f fakeDescriptionWriter) PlaylistDescriptions(_ context.Context, _ string, _ []library.PlaylistTrackBrief) (studio.PlaylistTones, error) {
	return f.tones, f.err
}

type playlistAITS struct {
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

// newPlaylistAIServer builds an authed (dev) and anonymous (oidc) handler over
// a shared store, wiring fake AI dependencies so no live LLM/image call is
// made. A nil dependency leaves the corresponding route gated off (404).
func newPlaylistAIServer(t *testing.T, gen imagegen.Provider, gp studio.GenrePrompter, dw studio.DescriptionWriter) *playlistAITS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: 50, BFLModel: "flux-2-klein-4b",
			BFLPollTimeout: 1_000_000_000,
		}
		if gen != nil {
			cfg.BFLAPIKey = "test-key"
		}
		return NewWithPlaylistAI(cfg, st, spa, gen, gp, dw)
	}
	return &playlistAITS{
		dev:  mk(config.AuthModeDev),
		anon: mk(config.AuthModeOIDC),
		repo: library.NewRepo(st.DB()),
	}
}

// seedPlaylistWithSong creates a playlist containing one song (with a genre),
// grounding data for the AI endpoints.
func seedPlaylistWithSong(t *testing.T, repo *library.Repo, name string) string {
	t.Helper()
	ctx := context.Background()
	s, err := repo.Create(ctx, library.NewID(), library.CreateSongParams{
		Title: "One", ArtistName: "The Artist", Album: "Album",
		FilePath: "songs/a.mp3", ContentHash: "h1", Genres: []string{"Synthwave"},
	})
	if err != nil {
		t.Fatalf("create song: %v", err)
	}
	pid, err := repo.CreatePlaylist(ctx, name, "")
	if err != nil {
		t.Fatalf("create playlist: %v", err)
	}
	if err := repo.AddSong(ctx, pid, s.ID); err != nil {
		t.Fatalf("add song: %v", err)
	}
	return pid
}

// --- suggest-prompt ---

func TestPlaylistAI_SuggestPrompt_403WhenAnonymous(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, &fakeGenrePrompter{prompt: "x"}, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.anon, "/api/playlists/"+pid+"/suggest-prompt", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestPlaylistAI_SuggestPrompt_404WhenNotConfigured(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-prompt", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestPlaylistAI_SuggestPrompt_happyPath(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, &fakeGenrePrompter{prompt: "a neon skyline, synthwave haze"}, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-prompt", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	var out struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Prompt == "" {
		t.Fatalf("bad response %s (%v)", rec.Body, err)
	}
}

func TestPlaylistAI_SuggestPrompt_400WhenEmpty(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, &fakeGenrePrompter{prompt: "x"}, nil)
	pid, err := ts.repo.CreatePlaylist(context.Background(), "Empty", "")
	if err != nil {
		t.Fatalf("create playlist: %v", err)
	}
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-prompt", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

// --- refine-prompt ---

func TestPlaylistAI_RefinePrompt_403WhenAnonymous(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, &fakeGenrePrompter{prompt: "x"}, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.anon, "/api/playlists/"+pid+"/refine-prompt", map[string]any{
		"current": "a skyline", "instruction": "more neon",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestPlaylistAI_RefinePrompt_404WhenNotConfigured(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/refine-prompt", map[string]any{
		"current": "a skyline", "instruction": "more neon",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestPlaylistAI_RefinePrompt_happyPath(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, &fakeGenrePrompter{prompt: "a neon skyline, more saturated"}, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/refine-prompt", map[string]any{
		"current": "a skyline", "instruction": "more neon",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	var out struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Prompt == "" {
		t.Fatalf("bad response %s (%v)", rec.Body, err)
	}
}

// --- cover-from-id ---

func TestPlaylistAI_Cover_403WhenAnonymous(t *testing.T) {
	ts := newPlaylistAIServer(t, okProvider(t), nil, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.anon, "/api/playlists/"+pid+"/cover", map[string]any{
		"studioCoverArtId": "x",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestPlaylistAI_Cover_404WhenNotConfigured(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, nil) // no image gen provider => disabled
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/cover", map[string]any{
		"studioCoverArtId": "x",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestPlaylistAI_Cover_404WhenPlaylistUnknown(t *testing.T) {
	ts := newPlaylistAIServer(t, okProvider(t), nil, nil)
	rec := postJSON(t, ts.dev, "/api/playlists/nope/cover", map[string]any{
		"studioCoverArtId": "x",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestPlaylistAI_Cover_happyPath(t *testing.T) {
	ts := newPlaylistAIServer(t, okProvider(t), nil, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")

	// Seed a ready studio_coverart row via the real generate endpoint (fake
	// provider does no network I/O).
	genRec := postJSON(t, ts.dev, "/api/studio/coverart", map[string]any{
		"prompt": "a neon skyline", "model": "flux-2-pro",
	})
	if genRec.Code != http.StatusOK {
		t.Fatalf("generate cover code = %d, body %s", genRec.Code, genRec.Body)
	}
	var gen struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(genRec.Body.Bytes(), &gen); err != nil || gen.ID == "" {
		t.Fatalf("bad generate response %s (%v)", genRec.Body, err)
	}

	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/cover", map[string]any{
		"studioCoverArtId": gen.ID,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply cover code = %d, body %s", rec.Code, rec.Body)
	}
	var applied struct {
		CoverArtID string `json:"coverArtId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &applied); err != nil || applied.CoverArtID == "" {
		t.Fatalf("bad apply response %s (%v)", rec.Body, err)
	}

	pl, err := ts.repo.GetPlaylist(context.Background(), pid, true)
	if err != nil || pl == nil {
		t.Fatalf("get playlist: %v (%v)", err, pl)
	}
	if pl.CoverArtID != applied.CoverArtID {
		t.Fatalf("playlist cover = %q, want %q", pl.CoverArtID, applied.CoverArtID)
	}
}

// --- suggest-description ---

func TestPlaylistAI_SuggestDescription_403WhenAnonymous(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, fakeDescriptionWriter{tones: studio.PlaylistTones{Punchy: "p", Evocative: "e", Factual: "f"}})
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.anon, "/api/playlists/"+pid+"/suggest-description", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestPlaylistAI_SuggestDescription_404WhenNotConfigured(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, nil)
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-description", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestPlaylistAI_SuggestDescription_happyPath(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, fakeDescriptionWriter{tones: studio.PlaylistTones{
		Punchy: "Late-night synth drive.", Evocative: "Neon rain on empty streets.", Factual: "A synthwave playlist, 1 track.",
	}})
	pid := seedPlaylistWithSong(t, ts.repo, "Drive")
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-description", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	var out studio.PlaylistTones
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Punchy == "" || out.Evocative == "" || out.Factual == "" {
		t.Fatalf("missing tones: %+v", out)
	}
}

func TestPlaylistAI_SuggestDescription_400WhenEmpty(t *testing.T) {
	ts := newPlaylistAIServer(t, nil, nil, fakeDescriptionWriter{tones: studio.PlaylistTones{Punchy: "p", Evocative: "e", Factual: "f"}})
	pid, err := ts.repo.CreatePlaylist(context.Background(), "Empty", "")
	if err != nil {
		t.Fatalf("create playlist: %v", err)
	}
	rec := postJSON(t, ts.dev, "/api/playlists/"+pid+"/suggest-description", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}
