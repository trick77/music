package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"log/slog"
	"net/http"
	"time"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/config"
)

const (
	stateCookieName = "music_oidc_state"
	nonceCookieName = "music_oidc_nonce"
	// flowCookieTTL bounds how long a login may sit at the provider before the
	// state/nonce cookies expire.
	flowCookieTTL = 10 * time.Minute
	// sessionTTL is how long a signed session stays valid.
	sessionTTL = 7 * 24 * time.Hour
)

// authHandlers serves the OIDC Authorization-Code flow. It is only wired when
// an Authenticator is present (oidc mode).
type authHandlers struct {
	cfg    config.Config
	authr  *auth.Authenticator
	secure bool
}

func randToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// setCookie writes a hardened cookie. maxAge<0 clears it.
func (h *authHandlers) setCookie(w http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   h.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// login starts the flow: it mints state + nonce, stores them in short-lived
// cookies, and redirects to the provider.
func (h *authHandlers) login(w http.ResponseWriter, r *http.Request) {
	state := randToken()
	nonce := randToken()
	h.setCookie(w, stateCookieName, state, int(flowCookieTTL.Seconds()))
	h.setCookie(w, nonceCookieName, nonce, int(flowCookieTTL.Seconds()))
	http.Redirect(w, r, h.authr.AuthCodeURL(state, nonce), http.StatusFound)
}

// callback validates state + nonce, exchanges the code, verifies the ID token,
// applies group gating, and (only for a granted login) sets the session cookie.
func (h *authHandlers) callback(w http.ResponseWriter, r *http.Request) {
	stateParam := r.URL.Query().Get("state")
	stateCookie, stateErr := r.Cookie(stateCookieName)
	nonceCookie, nonceErr := r.Cookie(nonceCookieName)
	// Clear the transient flow cookies immediately, before writing any response
	// header. Doing this in a defer would be a no-op: http.Redirect/httpError
	// flush the header block first, so a later Set-Cookie is dropped.
	h.setCookie(w, stateCookieName, "", -1)
	h.setCookie(w, nonceCookieName, "", -1)

	// Reject empties explicitly: subtle.ConstantTimeCompare("","") == 1, so an
	// absent state cookie + absent state param would otherwise "match".
	if stateParam == "" || stateErr != nil || stateCookie.Value == "" ||
		subtle.ConstantTimeCompare([]byte(stateParam), []byte(stateCookie.Value)) != 1 {
		httpError(w, http.StatusBadRequest, "invalid state")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		httpError(w, http.StatusBadRequest, "missing code")
		return
	}
	if nonceErr != nil || nonceCookie.Value == "" {
		httpError(w, http.StatusBadRequest, "missing nonce")
		return
	}

	claims, err := h.authr.Exchange(r.Context(), code, nonceCookie.Value)
	if err != nil {
		// Warn, not Error: a user abandoning the consent screen or a
		// replayed/expired code also lands here, so this isn't necessarily a
		// server-side fault. redactErr is defence in depth: x/oauth2 doesn't
		// put client_secret in the token-endpoint URL today (it goes in the
		// POST body or a Basic-Auth header), but if some future provider
		// client or a proxied http.Client ever surfaces a URL-bearing error
		// with credentials in its query string or userinfo, this keeps that
		// out of the log.
		slog.Warn("oidc: exchange failed", "err", redactErr(err))
		httpError(w, http.StatusUnauthorized, "authentication failed")
		return
	}

	if h.authr.GrantsAccess(claims) {
		token, err := auth.SignSession(h.cfg.SessionSecret, auth.Session{
			Username:  claims.Username,
			ExpiresAt: time.Now().Add(sessionTTL),
		})
		if err != nil {
			serverError(w, "session error", err)
			return
		}
		h.setCookie(w, auth.SessionCookieName, token, int(sessionTTL.Seconds()))
	} else {
		// Valid login but not in the allowed group: behave exactly like an
		// anonymous visitor — clear any prior session, issue none.
		h.setCookie(w, auth.SessionCookieName, "", -1)
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// logout clears the session and returns to the configured post-logout target
// (a trusted env value, never caller-supplied — no open redirect).
func (h *authHandlers) logout(w http.ResponseWriter, r *http.Request) {
	h.setCookie(w, auth.SessionCookieName, "", -1)
	dest := h.cfg.OIDC.PostLogoutRedirectURL
	if dest == "" {
		dest = "/"
	}
	http.Redirect(w, r, dest, http.StatusFound)
}
