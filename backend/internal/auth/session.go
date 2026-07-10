// Package auth implements the music backend's session and OpenID Connect
// authentication. Sessions are stateless, HMAC-signed cookies (no DB rows).
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// SessionCookieName is the cookie that carries a signed session.
const SessionCookieName = "music_session"

// Session is the authenticated caller state stored in a signed cookie. It is
// only ever issued to a login that was granted the full-access role, so its
// mere valid presence means "authenticated".
type Session struct {
	Username  string
	ExpiresAt time.Time
}

type sessionPayload struct {
	U   string `json:"u"`
	Exp int64  `json:"exp"`
}

var b64 = base64.RawURLEncoding

// SignSession serializes and HMAC-SHA256 signs s with secret, producing a
// cookie value of the form "<base64url(payload)>.<base64url(mac)>".
func SignSession(secret string, s Session) (string, error) {
	if secret == "" {
		return "", errors.New("session secret is empty")
	}
	payload, err := json.Marshal(sessionPayload{U: s.Username, Exp: s.ExpiresAt.Unix()})
	if err != nil {
		return "", err
	}
	encPayload := b64.EncodeToString(payload)
	mac := sign(secret, encPayload)
	return encPayload + "." + mac, nil
}

// ParseSession verifies the signature with secret and the expiry, returning the
// decoded session. Any tampering, wrong secret, malformed value, or expiry
// yields an error.
func ParseSession(secret, raw string) (Session, error) {
	if secret == "" {
		return Session{}, errors.New("session secret is empty")
	}
	encPayload, mac, ok := strings.Cut(raw, ".")
	if !ok || encPayload == "" || mac == "" {
		return Session{}, errors.New("malformed session cookie")
	}
	expected := sign(secret, encPayload)
	// Constant-time compare of equal-length hex/base64 strings.
	if !hmac.Equal([]byte(mac), []byte(expected)) {
		return Session{}, errors.New("session signature mismatch")
	}
	payloadBytes, err := b64.DecodeString(encPayload)
	if err != nil {
		return Session{}, errors.New("session payload not decodable")
	}
	var p sessionPayload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return Session{}, errors.New("session payload not parseable")
	}
	exp := time.Unix(p.Exp, 0)
	if !time.Now().Before(exp) {
		return Session{}, errors.New("session expired")
	}
	return Session{Username: p.U, ExpiresAt: exp}, nil
}

func sign(secret, msg string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(msg))
	return b64.EncodeToString(m.Sum(nil))
}
