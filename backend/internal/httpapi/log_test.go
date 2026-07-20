package httpapi

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// TestRedactErr_stripsQueryStringThroughWrap is the key regression test: the
// obvious "errors.As + mutate the *url.Error in place" implementation is a
// no-op once the error has been wrapped with fmt.Errorf's %w, because %w
// renders and freezes the message at wrap time. auth.Authenticator.Exchange
// always wraps like this, so this must work through a wrap.
func TestRedactErr_stripsQueryStringThroughWrap(t *testing.T) {
	inner := &url.Error{
		Op:  "Post",
		URL: "https://provider.example/token?client_secret=SUPERSECRET&code=abc123",
		Err: errors.New("dial tcp: connection refused"),
	}
	wrapped := fmt.Errorf("code exchange: %w", inner)

	got := redactErr(wrapped)
	if got == nil {
		t.Fatal("redactErr(wrapped) = nil")
	}
	msg := got.Error()
	if strings.Contains(msg, "SUPERSECRET") {
		t.Fatalf("secret leaked through wrap: %s", msg)
	}
	if strings.Contains(msg, "abc123") {
		t.Fatalf("code leaked through wrap: %s", msg)
	}
	if !strings.Contains(msg, "provider.example") {
		t.Fatalf("host was scrubbed away, want it kept: %s", msg)
	}
	if !strings.Contains(msg, "/token") {
		t.Fatalf("path was scrubbed away, want it kept: %s", msg)
	}
}

func TestRedactErr_stripsUserinfo(t *testing.T) {
	err := errors.New(`fetch failed: Get "https://alice:hunter2@example.com/path": connection refused`)

	got := redactErr(err)
	msg := got.Error()
	if strings.Contains(msg, "hunter2") {
		t.Fatalf("password leaked: %s", msg)
	}
	if strings.Contains(msg, "alice") {
		t.Fatalf("username leaked: %s", msg)
	}
	if !strings.Contains(msg, "example.com") {
		t.Fatalf("host was scrubbed away, want it kept: %s", msg)
	}
	if !strings.Contains(msg, "/path") {
		t.Fatalf("path was scrubbed away, want it kept: %s", msg)
	}
}

func TestRedactErr_plainAndNilUnchanged(t *testing.T) {
	if got := redactErr(nil); got != nil {
		t.Fatalf("redactErr(nil) = %v, want nil", got)
	}
	plain := errors.New("nonce mismatch")
	got := redactErr(plain)
	if got != plain {
		t.Fatalf("redactErr(plain) = %v (%p), want the original error unchanged (%p)", got, got, plain)
	}
}
