package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
)

func testHandler(t *testing.T, mode config.AuthMode) http.Handler {
	t.Helper()
	cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, nil, spa)
}

func TestHealth(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/api/health", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestSession_devIsAuthenticated(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	var body struct {
		Authenticated bool   `json:"authenticated"`
		Username      string `json:"username"`
	}
	json.NewDecoder(rr.Body).Decode(&body)
	if !body.Authenticated || body.Username != "dev" {
		t.Fatalf("session = %+v, want authenticated dev", body)
	}
}

func TestSession_oidcAnonymousByDefault(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeOIDC).ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	var body struct {
		Authenticated bool `json:"authenticated"`
	}
	json.NewDecoder(rr.Body).Decode(&body)
	if body.Authenticated {
		t.Fatal("oidc with no session should be anonymous in Phase 1")
	}
}

func TestSession_imageGenEnabledGatedByAuthAndKey(t *testing.T) {
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	get := func(cfg config.Config) string {
		rr := httptest.NewRecorder()
		New(cfg, nil, spa).ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
		return rr.Body.String()
	}
	// dev (authenticated) + BFL key => true
	dev := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}, BFLAPIKey: "k"}
	if !strings.Contains(get(dev), `"imageGenEnabled":true`) {
		t.Fatalf("dev+key should be true: %s", get(dev))
	}
	// oidc (anonymous) + BFL key => false
	anon := config.Config{AuthMode: config.AuthModeOIDC, BFLAPIKey: "k"}
	if !strings.Contains(get(anon), `"imageGenEnabled":false`) {
		t.Fatalf("anonymous must be false: %s", get(anon))
	}
}

func TestSPAFallthrough(t *testing.T) {
	rr := httptest.NewRecorder()
	testHandler(t, config.AuthModeDev).ServeHTTP(rr, httptest.NewRequest("GET", "/anything", nil))
	if rr.Body.String() != "SPA" {
		t.Fatalf("non-api path should hit SPA, got %q", rr.Body.String())
	}
}
