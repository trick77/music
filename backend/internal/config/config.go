// Package config loads runtime configuration from BACKEND_* environment vars.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultBFLPollTimeout = 1 * time.Minute

type AuthMode string

const (
	AuthModeDev  AuthMode = "dev"
	AuthModeOIDC AuthMode = "oidc"
)

type DevUserConfig struct {
	Username string
}

// OIDCConfig holds the OpenID Connect settings used in oidc auth mode. In dev
// mode these are ignored (autologin), so they are only validated when
// AuthMode == oidc.
type OIDCConfig struct {
	Issuer                string
	ClientID              string
	ClientSecret          string
	RedirectURL           string
	PostLogoutRedirectURL string
	// AllowedGroup gates the authenticated/full-access role: a valid login must
	// be a member of this group. Empty = any valid login is full-access.
	AllowedGroup string
	// CookieSecure marks session/state/nonce cookies Secure. Derived from the
	// redirect URL scheme (https => true) so local http flows still work.
	CookieSecure bool
}

type Config struct {
	AuthMode      AuthMode
	DevUser       DevUserConfig
	OIDC          OIDCConfig
	DBPath        string
	MediaDir      string
	MaxUploadMB   int
	SessionSecret string
	ListenAddr    string

	BFLBaseURL     string
	BFLAPIKey      string
	BFLModel       string
	BFLPollTimeout time.Duration
}

// ImageGenEnabled reports whether AI image generation is configured (a BFL key is set).
func (c Config) ImageGenEnabled() bool { return c.BFLAPIKey != "" }

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
	cfg.OIDC = OIDCConfig{
		Issuer:                env("BACKEND_OIDC_ISSUER", ""),
		ClientID:              env("BACKEND_OIDC_CLIENT_ID", ""),
		ClientSecret:          env("BACKEND_OIDC_CLIENT_SECRET", ""),
		RedirectURL:           env("BACKEND_OIDC_REDIRECT_URL", ""),
		PostLogoutRedirectURL: env("BACKEND_OIDC_POST_LOGOUT_REDIRECT_URL", ""),
		AllowedGroup:          env("BACKEND_OIDC_ALLOWED_GROUP", ""),
	}
	cfg.OIDC.CookieSecure = strings.HasPrefix(strings.ToLower(cfg.OIDC.RedirectURL), "https://")
	if cfg.AuthMode == AuthModeOIDC {
		for _, req := range []struct {
			name, val string
		}{
			{"BACKEND_OIDC_ISSUER", cfg.OIDC.Issuer},
			{"BACKEND_OIDC_CLIENT_ID", cfg.OIDC.ClientID},
			{"BACKEND_OIDC_CLIENT_SECRET", cfg.OIDC.ClientSecret},
			{"BACKEND_OIDC_REDIRECT_URL", cfg.OIDC.RedirectURL},
		} {
			if strings.TrimSpace(req.val) == "" {
				return Config{}, fmt.Errorf("%s is required when BACKEND_AUTH_MODE=oidc", req.name)
			}
		}
	}
	cfg.BFLBaseURL = env("BACKEND_BFL_BASE_URL", "https://api.bfl.ai/v1")
	cfg.BFLAPIKey = env("BACKEND_BFL_API_KEY", "")
	cfg.BFLModel = env("BACKEND_BFL_MODEL", "flux-2-klein-4b")
	pollTimeout, err := time.ParseDuration(env("BACKEND_BFL_POLL_TIMEOUT", defaultBFLPollTimeout.String()))
	if err != nil || pollTimeout <= 0 {
		return Config{}, fmt.Errorf("BACKEND_BFL_POLL_TIMEOUT must be a duration greater than 0")
	}
	cfg.BFLPollTimeout = pollTimeout
	if cfg.BFLAPIKey != "" && cfg.BFLBaseURL == "" {
		return Config{}, fmt.Errorf("BACKEND_BFL_BASE_URL is required when BACKEND_BFL_API_KEY is set")
	}
	return cfg, nil
}
