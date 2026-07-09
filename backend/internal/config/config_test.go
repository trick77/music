package config

import "testing"

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
