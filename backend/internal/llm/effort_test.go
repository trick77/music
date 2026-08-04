package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A flow that asks for less depth gets it, and one that does not is untouched —
// the client's own setting still decides for every call that never opts in.
func TestChat_reasoningEffortFromContextOverridesTheClient(t *testing.T) {
	var gotEffort []any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		gotEffort = append(gotEffort, body["reasoning_effort"])
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, ReasoningEffort: EffortHigh}
	msgs := []Message{{Role: "user", Content: "hi"}}

	if _, err := c.Chat(WithReasoningEffort(context.Background(), EffortLow), msgs, nil); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if gotEffort[0] != EffortLow {
		t.Fatalf("reasoning_effort = %v, want the context override", gotEffort[0])
	}

	if _, err := c.Chat(context.Background(), msgs, nil); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if gotEffort[1] != EffortHigh {
		t.Fatalf("reasoning_effort = %v, want the client's own setting", gotEffort[1])
	}
}

// With neither an override nor a client setting the package default applies, so
// a caller that configures nothing still sends a valid effort.
func TestChat_reasoningEffortFallsBackToTheDefault(t *testing.T) {
	var got any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &body)
		got = body["reasoning_effort"]
		io.WriteString(w, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL}
	if _, err := c.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil); err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if got != defaultReasoningEffort {
		t.Fatalf("reasoning_effort = %v, want %q", got, defaultReasoningEffort)
	}
}
