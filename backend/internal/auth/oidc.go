package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/trick77/music/internal/config"
	"golang.org/x/oauth2"
)

// Claims is the subset of the ID token the app cares about.
type Claims struct {
	Username string
	Groups   []string
}

// Authenticator wraps the OIDC provider, the ID-token verifier and the OAuth2
// config for the Authorization-Code flow. It performs signature/issuer/audience/
// expiry verification via coreos/go-oidc and enforces nonce + group gating.
type Authenticator struct {
	verifier     *oidc.IDTokenVerifier
	oauth        oauth2.Config
	allowedGroup string
}

// NewAuthenticator discovers the provider metadata (a network call to the
// issuer's well-known document) and builds the verifier and OAuth2 config.
func NewAuthenticator(ctx context.Context, cfg config.OIDCConfig) (*Authenticator, error) {
	// Pass the issuer verbatim: go-oidc requires the discovery document's
	// "issuer" to match exactly (Authentik issuers keep their trailing slash).
	provider, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	return &Authenticator{
		// No Skip* options: this checks signature, issuer, audience (ClientID)
		// and expiry.
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email", "groups"},
		},
		allowedGroup: cfg.AllowedGroup,
	}, nil
}

// AuthCodeURL builds the provider authorization URL carrying state and nonce.
func (a *Authenticator) AuthCodeURL(state, nonce string) string {
	return a.oauth.AuthCodeURL(state, oidc.Nonce(nonce))
}

// Exchange trades the authorization code for tokens, verifies the ID token and
// the nonce, and returns the identity claims. It never returns claims on any
// verification failure.
func (a *Authenticator) Exchange(ctx context.Context, code, wantNonce string) (Claims, error) {
	tok, err := a.oauth.Exchange(ctx, code)
	if err != nil {
		return Claims{}, fmt.Errorf("code exchange: %w", err)
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok || rawID == "" {
		return Claims{}, errors.New("token response missing id_token")
	}
	idToken, err := a.verifier.Verify(ctx, rawID)
	if err != nil {
		return Claims{}, fmt.Errorf("id token verify: %w", err)
	}
	// Nonce binds this ID token to our login request. Reject empty on either
	// side (an absent nonce claim must never satisfy the check).
	if wantNonce == "" || idToken.Nonce == "" ||
		subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(wantNonce)) != 1 {
		return Claims{}, errors.New("nonce mismatch")
	}
	var raw struct {
		Username string   `json:"preferred_username"`
		Groups   []string `json:"groups"`
	}
	if err := idToken.Claims(&raw); err != nil {
		return Claims{}, fmt.Errorf("parse claims: %w", err)
	}
	username := raw.Username
	if username == "" {
		username = idToken.Subject
	}
	return Claims{Username: username, Groups: raw.Groups}, nil
}

// GrantsAccess reports whether these claims earn the full-access role. When the
// allowed group is unset, any valid login is full-access; otherwise membership
// in that group is required. A login that does not qualify is treated exactly
// like an anonymous visitor (read-only).
func (a *Authenticator) GrantsAccess(c Claims) bool {
	if a.allowedGroup == "" {
		return true
	}
	for _, g := range c.Groups {
		if g == a.allowedGroup {
			return true
		}
	}
	return false
}
