// Package mockoidc is a minimal, dependency-free OpenID Connect provider used
// to exercise the real go-oidc verification path in tests and for local
// Playwright validation. It is NOT part of the shipped application: only the
// unit suite and the cmd/mockoidc dev binary import it.
//
// It hand-rolls RS256 JWT signing and a JWKS document so the production code
// (coreos/go-oidc) does the actual signature/issuer/audience/expiry checks.
package mockoidc

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

const keyID = "mock-key-1"

var b64 = base64.RawURLEncoding

// Server is an in-process mock OIDC provider. Zero value is not usable; call
// New. Issuer must equal the externally reachable base URL (no trailing slash
// beyond what the discovery document reports).
type Server struct {
	// Username / Groups are the identity minted by the token endpoint for the
	// authorization-code path (used by the standalone dev binary and browser
	// flows). Unit tests that need other claims mint tokens with SignIDToken.
	Username string
	Groups   []string

	key      *rsa.PrivateKey
	mu       sync.Mutex
	issuer   string
	codes    map[string]string // authorization code -> nonce
	tokenTTL time.Duration
}

// New builds a mock server with a fresh RSA key. issuer may be set later with
// SetIssuer (needed when the reachable URL is only known after the test server
// starts).
func New(issuer string) *Server {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &Server{
		Username: "mockuser",
		Groups:   []string{"music-users"},
		key:      key,
		issuer:   strings.TrimRight(issuer, "/"),
		codes:    map[string]string{},
		tokenTTL: time.Hour,
	}
}

// SetIssuer updates the issuer URL (must match how clients discover it).
func (s *Server) SetIssuer(issuer string) { s.issuer = strings.TrimRight(issuer, "/") }

// Issuer returns the configured issuer URL.
func (s *Server) Issuer() string { return s.issuer }

// Key exposes the signing key (tests use it to mint wrong-key tokens by
// generating a second key of their own).
func (s *Server) Key() *rsa.PrivateKey { return s.key }

// Handler returns the OIDC endpoints: discovery, JWKS, authorize, token.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", s.discovery)
	mux.HandleFunc("/jwks", s.jwks)
	mux.HandleFunc("/authorize", s.authorize)
	mux.HandleFunc("/token", s.token)
	return mux
}

func (s *Server) discovery(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"issuer":                                s.issuer,
		"authorization_endpoint":                s.issuer + "/authorize",
		"token_endpoint":                        s.issuer + "/token",
		"jwks_uri":                              s.issuer + "/jwks",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "groups"},
	})
}

func (s *Server) jwks(w http.ResponseWriter, _ *http.Request) {
	pub := s.key.PublicKey
	eBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(eBytes, uint64(pub.E))
	eBytes = trimLeadingZeros(eBytes)
	writeJSON(w, map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": keyID,
			"n":   b64.EncodeToString(pub.N.Bytes()),
			"e":   b64.EncodeToString(eBytes),
		}},
	})
}

// authorize immediately (no login page) redirects back to the client's
// redirect_uri with a fresh code, echoing state. The nonce is remembered so the
// token endpoint can embed it in the ID token.
func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	redirectURI := q.Get("redirect_uri")
	if redirectURI == "" {
		http.Error(w, "missing redirect_uri", http.StatusBadRequest)
		return
	}
	code := randString(24)
	s.mu.Lock()
	s.codes[code] = q.Get("nonce")
	s.mu.Unlock()

	sep := "?"
	if strings.Contains(redirectURI, "?") {
		sep = "&"
	}
	loc := redirectURI + sep + "code=" + code
	if st := q.Get("state"); st != "" {
		loc += "&state=" + st
	}
	http.Redirect(w, r, loc, http.StatusFound)
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	code := r.PostFormValue("code")
	s.mu.Lock()
	nonce, ok := s.codes[code]
	delete(s.codes, code)
	s.mu.Unlock()
	if !ok {
		http.Error(w, "invalid code", http.StatusBadRequest)
		return
	}
	// oauth2 authenticates the client with HTTP Basic auth by default; fall
	// back to the form field for clients that post credentials.
	clientID, _, _ := r.BasicAuth()
	if clientID == "" {
		clientID = r.PostFormValue("client_id")
	}
	now := time.Now()
	idToken, err := s.SignIDToken(map[string]any{
		"iss":                s.issuer,
		"sub":                "mock|" + s.Username,
		"aud":                clientID,
		"exp":                now.Add(s.tokenTTL).Unix(),
		"iat":                now.Unix(),
		"nonce":              nonce,
		"preferred_username": s.Username,
		"groups":             s.Groups,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"access_token": randString(16),
		"token_type":   "Bearer",
		"expires_in":   int(s.tokenTTL.Seconds()),
		"id_token":     idToken,
	})
}

// SignIDToken mints an RS256 JWT signed with the server key. Callers set the
// claims explicitly (iss/aud/exp/nonce/groups/...). Used by the token endpoint
// and directly by tests.
func (s *Server) SignIDToken(claims map[string]any) (string, error) {
	return signRS256(s.key, claims)
}

// SignIDTokenWithKey mints a token signed with an arbitrary key — tests use it
// to produce a token that fails signature verification against the JWKS.
func SignIDTokenWithKey(key *rsa.PrivateKey, claims map[string]any) (string, error) {
	return signRS256(key, claims)
}

func signRS256(key *rsa.PrivateKey, claims map[string]any) (string, error) {
	header := map[string]any{"alg": "RS256", "typ": "JWT", "kid": keyID}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signingInput := b64.EncodeToString(hb) + "." + b64.EncodeToString(cb)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + b64.EncodeToString(sig), nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func trimLeadingZeros(b []byte) []byte {
	i := 0
	for i < len(b)-1 && b[i] == 0 {
		i++
	}
	return b[i:]
}

func randString(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return b64.EncodeToString(buf)
}
