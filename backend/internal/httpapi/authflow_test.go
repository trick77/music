package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/mockoidc"
)

// oidcTestEnv wires a mock OIDC provider, an Authenticator, and an httpapi
// handler in oidc mode.
type oidcTestEnv struct {
	handler http.Handler
	mock    *mockoidc.Server
	cfg     config.Config
}

func newOIDCEnv(t *testing.T, allowedGroup string) *oidcTestEnv {
	t.Helper()
	mock := mockoidc.New("")
	ts := httptest.NewServer(mock.Handler())
	t.Cleanup(ts.Close)
	mock.SetIssuer(ts.URL)

	cfg := config.Config{
		AuthMode:      config.AuthModeOIDC,
		SessionSecret: "test-session-secret-long",
		OIDC: config.OIDCConfig{
			Issuer:                ts.URL,
			ClientID:              "music",
			ClientSecret:          "sekret",
			RedirectURL:           "http://localhost:8080/api/auth/callback",
			PostLogoutRedirectURL: "http://localhost:8080/",
			AllowedGroup:          allowedGroup,
			CookieSecure:          false,
		},
	}
	authr, err := auth.NewAuthenticator(t.Context(), cfg.OIDC)
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return &oidcTestEnv{handler: NewWithAuth(cfg, nil, spa, authr), mock: mock, cfg: cfg}
}

// login hits /api/auth/login and returns the state/nonce cookies plus the
// provider authorize URL from the redirect.
func (e *oidcTestEnv) login(t *testing.T) (cookies []*http.Cookie, authorizeURL string) {
	t.Helper()
	rr := httptest.NewRecorder()
	e.handler.ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/login", nil))
	if rr.Code != http.StatusFound {
		t.Fatalf("login status = %d, want 302", rr.Code)
	}
	return rr.Result().Cookies(), rr.Header().Get("Location")
}

// authorize follows the provider authorize URL to get a code bound to the nonce.
func authorizeCode(t *testing.T, authorizeURL string) string {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(authorizeURL)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	defer resp.Body.Close()
	loc, err := resp.Location()
	if err != nil {
		t.Fatalf("authorize redirect: %v", err)
	}
	return loc.Query().Get("code")
}

func cookieByName(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func stateFrom(cookies []*http.Cookie) string {
	if c := cookieByName(cookies, "music_oidc_state"); c != nil {
		return c.Value
	}
	return ""
}

// callback invokes /api/auth/callback with the given query and cookies.
func (e *oidcTestEnv) callback(t *testing.T, code, state string, cookies []*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/auth/callback?code="+code+"&state="+state, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rr := httptest.NewRecorder()
	e.handler.ServeHTTP(rr, req)
	return rr
}

func TestOIDCFlow_memberGetsSession(t *testing.T) {
	e := newOIDCEnv(t, "music-users") // mock user defaults to group music-users
	cookies, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	rr := e.callback(t, code, stateFrom(cookies), cookies)

	if rr.Code != http.StatusFound {
		t.Fatalf("callback status = %d, want 302 (%s)", rr.Code, rr.Body.String())
	}
	if loc := rr.Header().Get("Location"); loc != "/" {
		t.Fatalf("callback redirect = %q, want /", loc)
	}
	sc := cookieByName(rr.Result().Cookies(), auth.SessionCookieName)
	if sc == nil || sc.Value == "" {
		t.Fatal("expected a session cookie for a group member")
	}
	if !sc.HttpOnly || sc.SameSite != http.SameSiteLaxMode || sc.Path != "/" {
		t.Fatalf("session cookie not hardened: %+v", sc)
	}
	// The session must now read as authenticated.
	sess := e.sessionState(t, rr.Result().Cookies())
	if !strings.Contains(sess, `"authenticated":true`) {
		t.Fatalf("session not authenticated after login: %s", sess)
	}
}

func TestOIDCFlow_nonMemberIsReadOnly(t *testing.T) {
	e := newOIDCEnv(t, "music-users")
	e.mock.Groups = []string{"outsiders"} // valid login, not in the allowed group
	cookies, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	rr := e.callback(t, code, stateFrom(cookies), cookies)

	if rr.Code != http.StatusFound {
		t.Fatalf("callback status = %d, want 302", rr.Code)
	}
	if sc := cookieByName(rr.Result().Cookies(), auth.SessionCookieName); sc != nil && sc.Value != "" && sc.MaxAge >= 0 {
		t.Fatalf("non-member must NOT get a live session cookie, got %+v", sc)
	}
	// And the session endpoint reports anonymous (identical to a visitor).
	sess := e.sessionState(t, rr.Result().Cookies())
	if !strings.Contains(sess, `"authenticated":false`) {
		t.Fatalf("non-member session must be anonymous: %s", sess)
	}
}

func TestOIDCFlow_unsetGroupGrantsAnyLogin(t *testing.T) {
	e := newOIDCEnv(t, "") // no allowed group => any valid login is full-access
	e.mock.Groups = nil
	cookies, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	rr := e.callback(t, code, stateFrom(cookies), cookies)
	if cookieByName(rr.Result().Cookies(), auth.SessionCookieName) == nil {
		t.Fatal("unset allowed group must grant a session to any login")
	}
}

func TestOIDCFlow_stateMismatchRejected(t *testing.T) {
	e := newOIDCEnv(t, "")
	cookies, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	rr := e.callback(t, code, "tampered-state", cookies)
	if rr.Code == http.StatusFound {
		t.Fatal("state mismatch must not complete login")
	}
	if cookieByName(rr.Result().Cookies(), auth.SessionCookieName) != nil {
		t.Fatal("state mismatch must not set a session")
	}
}

func TestOIDCFlow_missingStateCookieRejected(t *testing.T) {
	e := newOIDCEnv(t, "")
	_, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	// Send a state query param but NO state cookie (empty-vs-empty must not pass).
	rr := e.callback(t, code, "", nil)
	if rr.Code == http.StatusFound {
		t.Fatal("missing state cookie must not complete login")
	}
}

func TestOIDCFlow_missingCodeRejected(t *testing.T) {
	e := newOIDCEnv(t, "")
	cookies, _ := e.login(t)
	rr := e.callback(t, "", stateFrom(cookies), cookies)
	if rr.Code == http.StatusFound {
		t.Fatal("missing code must not complete login")
	}
}

func TestOIDCFlow_logoutClearsSession(t *testing.T) {
	e := newOIDCEnv(t, "music-users")
	cookies, authorizeURL := e.login(t)
	code := authorizeCode(t, authorizeURL)
	rr := e.callback(t, code, stateFrom(cookies), cookies)
	sessionCookies := rr.Result().Cookies()

	req := httptest.NewRequest("GET", "/api/auth/logout", nil)
	for _, c := range sessionCookies {
		req.AddCookie(c)
	}
	lr := httptest.NewRecorder()
	e.handler.ServeHTTP(lr, req)
	if lr.Code != http.StatusFound {
		t.Fatalf("logout status = %d, want 302", lr.Code)
	}
	cleared := cookieByName(lr.Result().Cookies(), auth.SessionCookieName)
	if cleared == nil || cleared.MaxAge >= 0 {
		t.Fatalf("logout must clear the session cookie, got %+v", cleared)
	}
	if loc := lr.Header().Get("Location"); loc != e.cfg.OIDC.PostLogoutRedirectURL {
		t.Fatalf("logout redirect = %q, want %q", loc, e.cfg.OIDC.PostLogoutRedirectURL)
	}
}

func (e *oidcTestEnv) sessionState(t *testing.T, cookies []*http.Cookie) string {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/auth/session", nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rr := httptest.NewRecorder()
	e.handler.ServeHTTP(rr, req)
	return rr.Body.String()
}
