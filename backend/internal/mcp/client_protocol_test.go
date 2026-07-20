package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// A streamable-HTTP session expires server-side. The client must notice, drop
// the dead session, re-initialize and retry transparently — otherwise every
// long-lived Studio process breaks the first time Tavily rotates a session.
func TestCallWithSession_recoversFromExpiredSession(t *testing.T) {
	var listCalls, initCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)

		switch req.Method {
		case "initialize":
			initCalls.Add(1)
			w.Header().Set("Mcp-Session-Id", "sess-"+strconv.Itoa(int(initCalls.Load())))
		case "tools/list":
			// The first tools/list is rejected as an expired session.
			if listCalls.Add(1) == 1 {
				http.Error(w, "Bad Request: Mcp-Session-Id header is invalid or the session expired", http.StatusBadRequest)
				return
			}
		}
		result := `{}`
		if req.Method == "tools/list" {
			result = `{"tools":[{"name":"tavily_search","description":"d","inputSchema":{}}]}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"result":`+result+`}`)
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{URL: srv.URL}, nil)
	tools, err := c.listTools(context.Background())
	if err != nil {
		t.Fatalf("listTools should recover from an expired session: %v", err)
	}
	if len(tools) != 1 || tools[0].Name != "tavily__tavily_search" {
		t.Fatalf("tools = %+v", tools)
	}
	// Recovery means: initialize ran twice (fresh session) and tools/list retried.
	if got := initCalls.Load(); got != 2 {
		t.Errorf("initialize ran %d times, want 2 (session must be re-established)", got)
	}
	if got := listCalls.Load(); got != 2 {
		t.Errorf("tools/list ran %d times, want 2 (the call must be retried)", got)
	}
}

// A non-session 4xx must NOT trigger the retry dance — retrying an auth failure
// just doubles the load and hides the real error.
func TestCallWithSession_doesNotRetryNonSessionErrors(t *testing.T) {
	var listCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)
		if req.Method == "tools/list" {
			listCalls.Add(1)
			http.Error(w, "invalid api key", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"result":{}}`)
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{URL: srv.URL}, nil)
	if _, err := c.listTools(context.Background()); err == nil {
		t.Fatal("expected a 401 to surface as an error")
	}
	if got := listCalls.Load(); got != 1 {
		t.Errorf("tools/list ran %d times, want 1 (a 401 must not be retried)", got)
	}
}

func TestIsSessionError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"400 mentioning session", &mcpStatusError{status: 400, body: "Mcp-Session-Id header invalid or SESSION expired"}, true},
		{"404 mentioning session", &mcpStatusError{status: 404, body: "no such session"}, true},
		{"400 without session word", &mcpStatusError{status: 400, body: "malformed json"}, false},
		{"401 mentioning session", &mcpStatusError{status: 401, body: "session"}, false},
		{"500 mentioning session", &mcpStatusError{status: 500, body: "session store down"}, false},
		{"plain error", errors.New("session"), false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSessionError(tc.err); got != tc.want {
				t.Errorf("isSessionError = %v, want %v", got, tc.want)
			}
		})
	}
}

// A tool that reports isError must become a Go error — otherwise the model is
// handed the failure text as if it were a successful result.
func TestCallTool_toolReportedErrorBecomesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)
		result := `{}`
		if req.Method == "tools/call" {
			result = `{"content":[{"type":"text","text":"rate limit exceeded"}],"isError":true}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"result":`+result+`}`)
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{URL: srv.URL}, nil)
	out, err := c.callTool(context.Background(), "tavily_search", map[string]any{"query": "x"})
	if err == nil {
		t.Fatal("isError:true must surface as an error")
	}
	if !strings.Contains(err.Error(), "rate limit exceeded") {
		t.Errorf("error should carry the tool's message, got %v", err)
	}
	if out != "" {
		t.Errorf("failed call must return no output, got %q", out)
	}
}

// A JSON-RPC error object is a protocol-level failure and must surface too.
func TestCall_rpcErrorSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID int64 `json:"id"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"error":{"code":-32601,"message":"method not found"}}`)
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{URL: srv.URL}, nil)
	if _, err := c.listTools(context.Background()); err == nil || !strings.Contains(err.Error(), "method not found") {
		t.Fatalf("err = %v, want the JSON-RPC error message", err)
	}
}

// Configured headers (and the negotiated session id) must be sent on every
// request, including the initialized notification.
func TestClient_sendsHeadersSessionAndInitializedNotification(t *testing.T) {
	type seen struct {
		method    string
		auth      string
		sessionID string
		accept    string
	}
	var mu sync.Mutex
	var requests []seen

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)
		mu.Lock()
		requests = append(requests, seen{
			method:    req.Method,
			auth:      r.Header.Get("Authorization"),
			sessionID: r.Header.Get("Mcp-Session-Id"),
			accept:    r.Header.Get("Accept"),
		})
		mu.Unlock()
		if req.Method == "notifications/initialized" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Mcp-Session-Id", "sess-1")
		result := `{}`
		if req.Method == "tools/list" {
			result = `{"tools":[{"name":"tavily_search","inputSchema":{}}]}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"result":`+result+`}`)
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{
		URL:     srv.URL,
		Headers: map[string]string{"Authorization": "Bearer tok"},
	}, nil)
	if _, err := c.listTools(context.Background()); err != nil {
		t.Fatalf("listTools: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	var sawInitialized, sawSessionOnList bool
	for _, req := range requests {
		if req.auth != "Bearer tok" {
			t.Errorf("%s missing configured Authorization header", req.method)
		}
		// The transport mandates clients accept both content types.
		if !strings.Contains(req.accept, "application/json") || !strings.Contains(req.accept, "text/event-stream") {
			t.Errorf("%s Accept = %q, must accept both json and SSE", req.method, req.accept)
		}
		if req.method == "notifications/initialized" {
			sawInitialized = true
			if req.sessionID != "sess-1" {
				t.Errorf("initialized notification missing session id, got %q", req.sessionID)
			}
		}
		if req.method == "tools/list" && req.sessionID == "sess-1" {
			sawSessionOnList = true
		}
	}
	if !sawInitialized {
		t.Error("the spec-required initialized notification was never sent")
	}
	if !sawSessionOnList {
		t.Error("tools/list did not carry the negotiated session id")
	}
}

// The client must find its own reply in an SSE stream regardless of unrelated
// traffic, comments, keep-alives or CRLF line endings.
func TestDecodeSSEResponse(t *testing.T) {
	t.Run("skips messages with other ids", func(t *testing.T) {
		stream := "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":98,\"result\":{\"other\":true}}\n\n" +
			"event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{\"mine\":true}}\n\n"
		got, err := decodeSSEResponse(strings.NewReader(stream), 99)
		if err != nil {
			t.Fatalf("decodeSSEResponse: %v", err)
		}
		if got.ID != 99 || !strings.Contains(string(got.Result), "mine") {
			t.Fatalf("got %+v, want the id-99 message", got)
		}
	})

	t.Run("tolerates CRLF and non-data lines", func(t *testing.T) {
		stream := ": keep-alive\r\nevent: message\r\nid: 7\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"ok\":true}}\r\n\r\n"
		got, err := decodeSSEResponse(strings.NewReader(stream), 5)
		if err != nil {
			t.Fatalf("decodeSSEResponse: %v", err)
		}
		if got.ID != 5 {
			t.Fatalf("got id %d, want 5", got.ID)
		}
	})

	t.Run("accepts a final event with no trailing blank line", func(t *testing.T) {
		stream := "data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}"
		got, err := decodeSSEResponse(strings.NewReader(stream), 3)
		if err != nil {
			t.Fatalf("decodeSSEResponse: %v", err)
		}
		if got.ID != 3 {
			t.Fatalf("got id %d, want 3", got.ID)
		}
	})

	t.Run("errors when no message matches", func(t *testing.T) {
		stream := "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"
		if _, err := decodeSSEResponse(strings.NewReader(stream), 42); err == nil {
			t.Fatal("expected an error when the stream carries no matching id")
		}
	})

	t.Run("skips unparseable data and keeps scanning", func(t *testing.T) {
		stream := "data: not json\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{}}\n\n"
		got, err := decodeSSEResponse(strings.NewReader(stream), 8)
		if err != nil {
			t.Fatalf("a malformed event must not abort the stream: %v", err)
		}
		if got.ID != 8 {
			t.Fatalf("got id %d, want 8", got.ID)
		}
	})

	t.Run("errors on an empty stream", func(t *testing.T) {
		if _, err := decodeSSEResponse(strings.NewReader(""), 1); err == nil {
			t.Fatal("expected an error for an empty stream")
		}
	})
}

// Tool output is injected straight into the model context, so non-text parts
// must be dropped and the total must be capped.
func TestToolContentText(t *testing.T) {
	t.Run("joins text parts and drops non-text and empty ones", func(t *testing.T) {
		got := toolContentText([]toolContent{
			{Type: "text", Text: "first"},
			{Type: "image", Text: "should be dropped"},
			{Type: "text", Text: ""},
			{Type: "text", Text: "second"},
		})
		if got != "first\nsecond" {
			t.Fatalf("got %q, want %q", got, "first\nsecond")
		}
	})

	t.Run("truncates at the output cap", func(t *testing.T) {
		huge := strings.Repeat("a", maxToolOutputBytes+5000)
		got := toolContentText([]toolContent{{Type: "text", Text: huge}})
		if len(got) != maxToolOutputBytes {
			t.Fatalf("len = %d, want the %d-byte cap", len(got), maxToolOutputBytes)
		}
	})

	t.Run("stops accumulating once the cap is reached", func(t *testing.T) {
		chunk := strings.Repeat("b", maxToolOutputBytes)
		got := toolContentText([]toolContent{
			{Type: "text", Text: chunk},
			{Type: "text", Text: "must not appear"},
		})
		if len(got) > maxToolOutputBytes+1 {
			t.Fatalf("len = %d, exceeds the cap", len(got))
		}
		if strings.Contains(got, "must not appear") {
			t.Error("content past the cap leaked into the output")
		}
	})

	t.Run("empty content yields empty string", func(t *testing.T) {
		if got := toolContentText(nil); got != "" {
			t.Fatalf("got %q, want empty", got)
		}
	})
}

// The Tavily API key rides in the URL query, so any *url.Error must be scrubbed
// before it reaches a log line or an error message.
func TestScrubURLError(t *testing.T) {
	t.Run("removes the query string and userinfo", func(t *testing.T) {
		in := &url.Error{
			Op:  "Post",
			URL: "https://user:pass@mcp.tavily.com/mcp/?tavilyApiKey=super-secret",
			Err: errors.New("connection refused"),
		}
		got := scrubURLError(in)
		msg := got.Error()
		for _, leak := range []string{"super-secret", "tavilyApiKey", "pass"} {
			if strings.Contains(msg, leak) {
				t.Errorf("scrubbed error still leaks %q: %s", leak, msg)
			}
		}
		// The useful part must survive.
		if !strings.Contains(msg, "mcp.tavily.com") || !strings.Contains(msg, "connection refused") {
			t.Errorf("scrubbing destroyed the diagnostic: %s", msg)
		}
	})

	t.Run("passes through non-url errors unchanged", func(t *testing.T) {
		in := errors.New("plain failure")
		if got := scrubURLError(in); got != in {
			t.Errorf("got %v, want the original error", got)
		}
	})
}

// The realistic leak path: Tavily is unreachable, so the transport returns a
// *url.Error carrying the full request URL — api key and all. That error is
// logged by Service.Tools, so it must be scrubbed first.
//
// Port 1 on loopback refuses immediately; no external network is involved.
//
// NOTE: this covers the *dial-failure* path only. A URL so malformed that
// url.Parse itself fails is NOT scrubbed and does leak the key — see summary.
func TestCall_dialFailureDoesNotLeakKey(t *testing.T) {
	c := newRemoteClient("tavily", ServerConfig{
		URL: "http://127.0.0.1:1/mcp/?tavilyApiKey=super-secret",
	}, nil)
	_, err := c.listTools(context.Background())
	if err == nil {
		t.Fatal("expected a dial error against a closed port")
	}
	if strings.Contains(err.Error(), "super-secret") || strings.Contains(err.Error(), "tavilyApiKey") {
		t.Errorf("error leaks the api key: %v", err)
	}
	// The host must survive so the failure is still diagnosable.
	if !strings.Contains(err.Error(), "127.0.0.1:1") {
		t.Errorf("scrubbing destroyed the diagnostic: %v", err)
	}
}

// A body that is not JSON at all must be a decode error, not a silent zero value.
func TestCall_nonJSONBodyIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "<html>gateway error</html>")
	}))
	defer srv.Close()

	c := newRemoteClient("tavily", ServerConfig{URL: srv.URL}, nil)
	if _, err := c.listTools(context.Background()); err == nil {
		t.Fatal("expected a decode error for a non-JSON body")
	}
}

// The allowlist is what keeps extract/map/crawl away from the model; an empty
// allowlist means "expose everything".
func TestToolAllowed(t *testing.T) {
	restricted := newRemoteClient("tavily", ServerConfig{Tools: []string{"tavily_search"}}, nil)
	if !restricted.toolAllowed("tavily_search") {
		t.Error("allowlisted tool must be allowed")
	}
	if restricted.toolAllowed("tavily_extract") {
		t.Error("non-allowlisted tool must be filtered out")
	}
	open := newRemoteClient("tavily", ServerConfig{}, nil)
	if !open.toolAllowed("anything") {
		t.Error("an empty allowlist must expose every tool")
	}
}
