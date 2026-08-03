package llm

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

var sessionIDPattern = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$`)

func TestNewSessionIDShape(t *testing.T) {
	id := newSessionID()
	if !sessionIDPattern.MatchString(id) {
		t.Fatalf("session id %q does not match ses_<12 hex><14 base62>", id)
	}
	if other := newSessionID(); other == id {
		t.Fatalf("consecutive session ids collided: %q", id)
	}
}

func TestWithSessionIsStableWithinAScope(t *testing.T) {
	ctx := WithSession(context.Background())
	first := sessionIDFrom(ctx)
	if again := sessionIDFrom(ctx); again != first {
		t.Fatalf("session id changed within one scope: %q then %q", first, again)
	}
	if other := sessionIDFrom(WithSession(context.Background())); other == first {
		t.Fatalf("separate scopes share a session id: %q", other)
	}
	if !sessionIDPattern.MatchString(first) {
		t.Fatalf("scoped session id %q does not match expected shape", first)
	}
}

func TestSessionIDFallsBackToProcessID(t *testing.T) {
	if got := sessionIDFrom(context.Background()); got != processSessionID {
		t.Fatalf("unscoped call used %q, want the per-process id %q", got, processSessionID)
	}
}

// TestChatUserAgentValue pins the exact User-Agent string. The header test below
// compares against the constant, so it would happily pass on any value; the
// upstream cares about this specific client string, so assert the literal.
func TestChatUserAgentValue(t *testing.T) {
	const want = "opencode/1.18.11 ai-sdk/openai-compatible/3.0.20 ai-sdk/provider-utils/5.0.18 runtime/bun/1.3.14"
	if chatUserAgent != want {
		t.Fatalf("chatUserAgent = %q, want %q", chatUserAgent, want)
	}
}

func TestChatRequestSendsSessionHeaders(t *testing.T) {
	var got http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(server.Close)

	client := &Client{BaseURL: server.URL, APIKey: "secret", HTTP: server.Client()}
	ctx := WithSession(context.Background())
	if _, err := client.Chat(ctx, []Message{{Role: "user", Content: "Hi"}}, nil); err != nil {
		t.Fatalf("Chat() error: %v", err)
	}

	if ua := got.Get("User-Agent"); ua != chatUserAgent {
		t.Fatalf("User-Agent = %q, want %q", ua, chatUserAgent)
	}
	if strings.HasPrefix(got.Get("User-Agent"), "Go-http-client") {
		t.Fatal("User-Agent fell back to the net/http default")
	}
	if accept := got.Get("Accept"); accept != "*/*" {
		t.Fatalf("Accept = %q, want */*", accept)
	}
	want := sessionIDFrom(ctx)
	if id := got.Get("X-Session-Id"); id != want {
		t.Fatalf("X-Session-Id = %q, want %q", id, want)
	}
	if affinity := got.Get("x-session-affinity"); affinity != want {
		t.Fatalf("x-session-affinity = %q, want %q", affinity, want)
	}
}
