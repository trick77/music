package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestChat_sendsOpenAIRequestAndParsesToolCalls(t *testing.T) {
	var gotBody map[string]any
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"choices":[{"message":{"content":"","tool_calls":[
			{"id":"call_1","type":"function","function":{"name":"fetch__fetch","arguments":"{\"url\":\"x\"}"}}
		]},"finish_reason":"tool_calls"}]}`)
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, APIKey: "k", Model: "mimo-v2.5-pro", ReasoningEffort: "high"}
	msg, err := c.Chat(context.Background(),
		[]Message{{Role: "user", Content: "hi"}},
		[]Tool{{Type: "function", Function: ToolFunction{Name: "fetch__fetch"}}})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if gotAuth != "Bearer k" {
		t.Fatalf("auth header = %q", gotAuth)
	}
	if gotBody["model"] != "mimo-v2.5-pro" || gotBody["reasoning_effort"] != "high" {
		t.Fatalf("request body = %v", gotBody)
	}
	if gotBody["stream"] != false {
		t.Fatalf("stream must be false, got %v", gotBody["stream"])
	}
	if len(msg.ToolCalls) != 1 || msg.ToolCalls[0].Function.Name != "fetch__fetch" {
		t.Fatalf("tool calls = %+v", msg.ToolCalls)
	}
	if msg.Role != "assistant" {
		t.Fatalf("role = %q, want assistant", msg.Role)
	}
}

func TestChat_parsesPlainContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"content":"hello world"},"finish_reason":"stop"}]}`)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, APIKey: "k"}
	msg, err := c.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}
	if msg.Content != "hello world" || len(msg.ToolCalls) != 0 {
		t.Fatalf("msg = %+v", msg)
	}
}

func TestChat_errorsOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, APIKey: "k"}
	if _, err := c.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil); err == nil {
		t.Fatal("expected error on 500")
	}
}
