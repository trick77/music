package httpapi

import (
	"net/http"

	"github.com/trick77/music/internal/config"
)

// Identity is the caller's auth state for a request.
type Identity struct {
	Authenticated bool
	Username      string
}

// identify resolves the caller. Phase 1: dev mode is always the full-access
// dev user; oidc mode is anonymous until real OIDC sessions land in Phase 7.
func identify(cfg config.Config, _ *http.Request) Identity {
	if cfg.AuthMode == config.AuthModeDev {
		return Identity{Authenticated: true, Username: cfg.DevUser.Username}
	}
	return Identity{Authenticated: false}
}
