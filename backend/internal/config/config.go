// Package config loads runtime configuration from BACKEND_* environment vars.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type AuthMode string

const (
	AuthModeDev  AuthMode = "dev"
	AuthModeOIDC AuthMode = "oidc"
)

type DevUserConfig struct {
	Username string
}

type Config struct {
	AuthMode      AuthMode
	DevUser       DevUserConfig
	DBPath        string
	MediaDir      string
	MaxUploadMB   int
	SessionSecret string
	ListenAddr    string
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func Load() (Config, error) {
	cfg := Config{
		AuthMode:      AuthMode(strings.TrimSpace(env("BACKEND_AUTH_MODE", "dev"))),
		DevUser:       DevUserConfig{Username: env("BACKEND_DEV_USER_USERNAME", "dev")},
		DBPath:        env("BACKEND_DB_PATH", "data/music.db"),
		MediaDir:      env("BACKEND_MEDIA_DIR", "data/media"),
		SessionSecret: env("BACKEND_SESSION_SECRET", ""),
		ListenAddr:    env("BACKEND_LISTEN_ADDR", ":8080"),
	}
	mb, err := strconv.Atoi(env("BACKEND_MAX_UPLOAD_MB", "50"))
	if err != nil || mb <= 0 {
		return Config{}, fmt.Errorf("BACKEND_MAX_UPLOAD_MB must be a positive integer")
	}
	cfg.MaxUploadMB = mb
	if cfg.SessionSecret == "" {
		return Config{}, fmt.Errorf("BACKEND_SESSION_SECRET is required")
	}
	if cfg.AuthMode != AuthModeDev && cfg.AuthMode != AuthModeOIDC {
		return Config{}, fmt.Errorf("BACKEND_AUTH_MODE must be 'dev' or 'oidc', got %q", cfg.AuthMode)
	}
	return cfg, nil
}
