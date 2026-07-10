package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/mockoidc"
)

// newTestAuth spins up the mock provider and a real Authenticator pointed at it.
func newTestAuth(t *testing.T, allowedGroup string) (*Authenticator, *mockoidc.Server) {
	t.Helper()
	mock := mockoidc.New("")
	ts := httptest.NewServer(mock.Handler())
	t.Cleanup(ts.Close)
	mock.SetIssuer(ts.URL)
	a, err := NewAuthenticator(context.Background(), config.OIDCConfig{
		Issuer:       ts.URL,
		ClientID:     "music",
		ClientSecret: "sekret",
		RedirectURL:  "http://localhost:8080/api/auth/callback",
		AllowedGroup: allowedGroup,
	})
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	return a, mock
}

// mountRawTokenProvider serves a token endpoint that always returns a single
// id_token (used to inject expired / wrong-key / bad-nonce / bad-aud tokens),
// while serving discovery + jwks from mock. mint is called with the final
// issuer URL so the token's iss claim matches what the verifier expects — the
// point is to fail on the injected defect, not on an issuer mismatch.
func mountRawTokenProvider(t *testing.T, mock *mockoidc.Server, mint func(issuer string) string) *Authenticator {
	t.Helper()
	var rawID string
	mux := http.NewServeMux()
	base := mock.Handler()
	mux.Handle("/.well-known/openid-configuration", base)
	mux.Handle("/jwks", base)
	mux.Handle("/authorize", base)
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"x","token_type":"Bearer","id_token":"` + rawID + `"}`))
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	mock.SetIssuer(ts.URL)
	rawID = mint(ts.URL)
	a, err := NewAuthenticator(context.Background(), config.OIDCConfig{
		Issuer: ts.URL, ClientID: "music", ClientSecret: "sekret",
		RedirectURL: "http://localhost:8080/api/auth/callback",
	})
	if err != nil {
		t.Fatalf("NewAuthenticator: %v", err)
	}
	return a
}

func TestExchange_happyPathReturnsClaims(t *testing.T) {
	a, mock := newTestAuth(t, "")
	mock.Username = "alice"
	mock.Groups = []string{"music-users", "admins"}
	code, nonce := driveAuthorize(t, a, mock)
	claims, err := a.Exchange(context.Background(), code, nonce)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if claims.Username != "alice" {
		t.Fatalf("username = %q, want alice", claims.Username)
	}
	if len(claims.Groups) != 2 {
		t.Fatalf("groups = %v", claims.Groups)
	}
}

func TestExchange_nonceMismatchRejected(t *testing.T) {
	a, mock := newTestAuth(t, "")
	code, _ := driveAuthorize(t, a, mock)
	if _, err := a.Exchange(context.Background(), code, "the-wrong-nonce"); err == nil {
		t.Fatal("expected nonce mismatch error")
	}
}

func TestExchange_emptyNonceRejected(t *testing.T) {
	_, mock := newTestAuth(t, "")
	// Mint a token with NO nonce claim; even an empty wantNonce must not pass.
	a2 := mountRawTokenProvider(t, mock, func(iss string) string {
		raw, err := mock.SignIDToken(map[string]any{
			"iss": iss, "sub": "s", "aud": "music",
			"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
			"preferred_username": "eve",
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	})
	if _, err := a2.Exchange(context.Background(), "anycode", ""); err == nil {
		t.Fatal("expected rejection of absent nonce")
	}
}

func TestExchange_expiredTokenRejected(t *testing.T) {
	_, mock := newTestAuth(t, "")
	a2 := mountRawTokenProvider(t, mock, func(iss string) string {
		raw, err := mock.SignIDToken(map[string]any{
			"iss": iss, "sub": "s", "aud": "music",
			"exp": time.Now().Add(-time.Minute).Unix(), "iat": time.Now().Add(-time.Hour).Unix(),
			"nonce": "n", "preferred_username": "old",
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	})
	if _, err := a2.Exchange(context.Background(), "anycode", "n"); err == nil {
		t.Fatal("expected expired-token rejection")
	}
}

func TestExchange_wrongSigningKeyRejected(t *testing.T) {
	_, mock := newTestAuth(t, "")
	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	a2 := mountRawTokenProvider(t, mock, func(iss string) string {
		raw, err := mockoidc.SignIDTokenWithKey(otherKey, map[string]any{
			"iss": iss, "sub": "s", "aud": "music",
			"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
			"nonce": "n", "preferred_username": "forged",
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	})
	if _, err := a2.Exchange(context.Background(), "anycode", "n"); err == nil {
		t.Fatal("expected signature-verification failure")
	}
}

func TestExchange_wrongAudienceRejected(t *testing.T) {
	_, mock := newTestAuth(t, "")
	a2 := mountRawTokenProvider(t, mock, func(iss string) string {
		raw, err := mock.SignIDToken(map[string]any{
			"iss": iss, "sub": "s", "aud": "some-other-client",
			"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
			"nonce": "n", "preferred_username": "x",
		})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	})
	if _, err := a2.Exchange(context.Background(), "anycode", "n"); err == nil {
		t.Fatal("expected audience-mismatch rejection")
	}
}

func TestGrantsAccess_groupGating(t *testing.T) {
	// Unset allowed group: any valid login is full-access.
	open, _ := newTestAuth(t, "")
	if !open.GrantsAccess(Claims{Username: "x", Groups: nil}) {
		t.Fatal("unset allowed group must grant access to any login")
	}
	// Set allowed group: only members qualify.
	gated, _ := newTestAuth(t, "music-users")
	if !gated.GrantsAccess(Claims{Username: "m", Groups: []string{"music-users"}}) {
		t.Fatal("member must be granted access")
	}
	if gated.GrantsAccess(Claims{Username: "n", Groups: []string{"other"}}) {
		t.Fatal("non-member must be denied (read-only)")
	}
	if gated.GrantsAccess(Claims{Username: "n", Groups: nil}) {
		t.Fatal("login with no groups must be denied when a group is required")
	}
}

// driveAuthorize walks the mock authorize endpoint to obtain a real code bound
// to a nonce, mirroring the browser redirect.
func driveAuthorize(t *testing.T, a *Authenticator, mock *mockoidc.Server) (code, nonce string) {
	t.Helper()
	nonce = "nonce-" + randToken(t)
	state := "state-" + randToken(t)
	authURL := a.AuthCodeURL(state, nonce)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(authURL)
	if err != nil {
		t.Fatalf("authorize GET: %v", err)
	}
	defer resp.Body.Close()
	loc, err := resp.Location()
	if err != nil {
		t.Fatalf("authorize redirect: %v", err)
	}
	return loc.Query().Get("code"), nonce
}

func randToken(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return string([]rune("abcdefghijklmnop"))[:1] + hexish(b)
}

func hexish(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, x := range b {
		out[i*2] = hexdigits[x>>4]
		out[i*2+1] = hexdigits[x&0xf]
	}
	return string(out)
}
