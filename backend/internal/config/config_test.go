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
