package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoad_devDefaults(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "test-secret")
	t.Setenv("BACKEND_AUTH_MODE", "dev")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.AuthMode != AuthModeDev {
		t.Fatalf("AuthMode = %q, want dev", cfg.AuthMode)
	}
	if cfg.DevUser.Username != "dev" {
		t.Fatalf("DevUser.Username = %q, want dev", cfg.DevUser.Username)
	}
	if cfg.DBPath == "" || cfg.MediaDir == "" {
		t.Fatalf("DBPath/MediaDir must have defaults, got %q / %q", cfg.DBPath, cfg.MediaDir)
	}
}

func TestLoad_requiresSessionSecret(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when BACKEND_SESSION_SECRET is empty")
	}
}

func TestLoad_BFLDefaults(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.BFLBaseURL != "https://api.bfl.ai/v1" || cfg.BFLModel != "flux-2-klein-4b" {
		t.Fatalf("BFL defaults = %q / %q", cfg.BFLBaseURL, cfg.BFLModel)
	}
	if cfg.BFLPollTimeout != time.Minute {
		t.Fatalf("BFLPollTimeout = %s, want 1m0s", cfg.BFLPollTimeout)
	}
	if cfg.ImageGenEnabled() {
		t.Fatal("ImageGenEnabled must be false with no API key")
	}
}

func TestLoad_BFLEnabledByAPIKey(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_BFL_API_KEY", "bfl-test")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.ImageGenEnabled() || cfg.BFLAPIKey != "bfl-test" {
		t.Fatalf("ImageGenEnabled/APIKey = %v / %q", cfg.ImageGenEnabled(), cfg.BFLAPIKey)
	}
}

func TestLoad_OIDCRequiresCoreFieldsInOIDCMode(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_AUTH_MODE", "oidc")
	// Issuer/ClientID/ClientSecret/RedirectURL are all required in oidc mode.
	t.Setenv("BACKEND_OIDC_ISSUER", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_OIDC_ISSUER") {
		t.Fatalf("expected missing-issuer error, got %v", err)
	}
	t.Setenv("BACKEND_OIDC_ISSUER", "https://auth.example.com/application/o/music/")
	t.Setenv("BACKEND_OIDC_CLIENT_ID", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_OIDC_CLIENT_ID") {
		t.Fatalf("expected missing-client-id error, got %v", err)
	}
	t.Setenv("BACKEND_OIDC_CLIENT_ID", "music")
	t.Setenv("BACKEND_OIDC_CLIENT_SECRET", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_OIDC_CLIENT_SECRET") {
		t.Fatalf("expected missing-client-secret error, got %v", err)
	}
	t.Setenv("BACKEND_OIDC_CLIENT_SECRET", "sekret")
	t.Setenv("BACKEND_OIDC_REDIRECT_URL", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_OIDC_REDIRECT_URL") {
		t.Fatalf("expected missing-redirect-url error, got %v", err)
	}
	t.Setenv("BACKEND_OIDC_REDIRECT_URL", "https://music.example.com/api/auth/callback")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load with full oidc config: %v", err)
	}
	if cfg.OIDC.Issuer == "" || cfg.OIDC.ClientID != "music" || cfg.OIDC.ClientSecret != "sekret" {
		t.Fatalf("OIDC fields not loaded: %+v", cfg.OIDC)
	}
	// https redirect => Secure cookies.
	if !cfg.OIDC.CookieSecure {
		t.Fatal("https redirect URL must yield CookieSecure=true")
	}
	if cfg.OIDC.AllowedGroup != "" {
		t.Fatalf("AllowedGroup default = %q, want empty", cfg.OIDC.AllowedGroup)
	}
}

func TestLoad_OIDCNotRequiredInDevMode(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_AUTH_MODE", "dev")
	// No OIDC_* set; must load fine in dev.
	if _, err := Load(); err != nil {
		t.Fatalf("dev mode must not require OIDC config: %v", err)
	}
}

func TestLoad_OIDCCookieInsecureForHTTPRedirect(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_AUTH_MODE", "oidc")
	t.Setenv("BACKEND_OIDC_ISSUER", "http://localhost:9000/")
	t.Setenv("BACKEND_OIDC_CLIENT_ID", "music")
	t.Setenv("BACKEND_OIDC_CLIENT_SECRET", "sekret")
	t.Setenv("BACKEND_OIDC_REDIRECT_URL", "http://localhost:8080/api/auth/callback")
	t.Setenv("BACKEND_OIDC_ALLOWED_GROUP", "music-users")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.OIDC.CookieSecure {
		t.Fatal("http redirect URL must yield CookieSecure=false (local dev)")
	}
	if cfg.OIDC.AllowedGroup != "music-users" {
		t.Fatalf("AllowedGroup = %q", cfg.OIDC.AllowedGroup)
	}
}

func TestLoad_BFLPollTimeoutOverrideAndReject(t *testing.T) {
	t.Setenv("BACKEND_SESSION_SECRET", "s")
	t.Setenv("BACKEND_BFL_POLL_TIMEOUT", "7m")
	cfg, err := Load()
	if err != nil || cfg.BFLPollTimeout != 7*time.Minute {
		t.Fatalf("override: %v / %s", err, cfg.BFLPollTimeout)
	}
	t.Setenv("BACKEND_BFL_POLL_TIMEOUT", "soon")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BACKEND_BFL_POLL_TIMEOUT") {
		t.Fatalf("reject invalid: %v", err)
	}
}
