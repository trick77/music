package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// TestCallback_exchangeFailureIsLogged drives a real Exchange failure (an
// authorization code the mock provider never issued, so the token endpoint
// 400s) through the callback handler and asserts the failure is actually
// logged at WARN with an "err" attribute — positively, not just "no secret
// present" (a broken/no-op logging change would pass a secret-absence check
// trivially). The client-visible response must stay byte-for-byte the same
// 401 it was before this change.
//
// This test does NOT assert anything about redaction: mockoidc's token
// endpoint never echoes the submitted code back, and oauth2.RetrieveError's
// message contains only the response status/body, never the request URL —
// client_secret and code travel in the POST body/Basic-Auth header, never in
// the URL. So there is no secret in this particular error to redact, and a
// leak assertion here would pass identically with redactErr deleted from the
// call site. Redaction itself — stripping a query string and userinfo out of
// a %w-wrapped *url.Error — is covered by the unit tests in log_test.go
// (TestRedactErr_stripsQueryStringThroughWrap and
// TestRedactErr_stripsUserinfo); this test covers only the handler wiring:
// that Exchange's error reaches slog.Warn at all.
func TestCallback_exchangeFailureIsLogged(t *testing.T) {
	var buf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	e := newOIDCEnv(t, "")
	cookies, _ := e.login(t)
	const bogusCode = "unregistered-code-SECRETVALUE123"

	rr := e.callback(t, bogusCode, stateFrom(cookies), cookies)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("callback status = %d, want 401 (%s)", rr.Code, rr.Body.String())
	}
	const wantBody = `{"error":"authentication failed"}` + "\n"
	if rr.Body.String() != wantBody {
		t.Fatalf("callback body = %q, want %q", rr.Body.String(), wantBody)
	}

	logged := buf.String()
	if !strings.Contains(logged, "oidc") || !strings.Contains(logged, "exchange") {
		t.Fatalf("expected the exchange failure to be logged, got: %s", logged)
	}
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected exchange failure to be logged at WARN, got: %s", logged)
	}
	if !strings.Contains(logged, "err=") {
		t.Fatalf("expected the log line to carry an err attribute, got: %s", logged)
	}
}
