package httpapi

import (
	"net/http"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/config"
)

// Identity is the caller's auth state for a request.
type Identity struct {
	Authenticated bool
	Username      string
}

// identify resolves the caller. In dev mode the fixed dev user is always
// full-access (autologin). In oidc mode the caller is authenticated iff they
// carry a valid, unexpired signed session cookie — which is only ever issued to
// a login that was granted the full-access role. A missing, tampered, expired,
// or non-member session therefore reads as anonymous (read-only).
func identify(cfg config.Config, r *http.Request) Identity {
	if cfg.AuthMode == config.AuthModeDev {
		return Identity{Authenticated: true, Username: cfg.DevUser.Username}
	}
	c, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		return Identity{Authenticated: false}
	}
	s, err := auth.ParseSession(cfg.SessionSecret, c.Value)
	if err != nil {
		return Identity{Authenticated: false}
	}
	return Identity{Authenticated: true, Username: s.Username}
}
