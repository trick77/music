package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// TestCallback_exchangeFailureIsLoggedWithoutLeakingCode drives a real
// Exchange failure (an authorization code the mock provider never issued, so
// the token endpoint 400s) through the callback handler and asserts two
// things at once: the failure is actually logged (a broken/no-op logging
// change would pass a "secret absent" check trivially), and the code from the
// callback URL never reaches the log. The client-visible response must stay
// byte-for-byte the same 401 it was before this change.
func TestCallback_exchangeFailureIsLoggedWithoutLeakingCode(t *testing.T) {
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
	if strings.Contains(logged, bogusCode) {
		t.Fatalf("auth code leaked into log output: %s", logged)
	}
}
