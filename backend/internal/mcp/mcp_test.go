package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// jsonrpcServer is a tiny MCP server answering initialize, tools/list and
// tools/call. sse toggles whether replies come back as an SSE stream.
func jsonrpcServer(t *testing.T, sse bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int64          `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)

		var result string
		switch req.Method {
		case "initialize":
			result = `{}`
		case "tools/list":
			result = `{"tools":[{"name":"tavily_search","description":"search the web","inputSchema":{"type":"object"}},{"name":"extract","description":"blocked by allowlist","inputSchema":{"type":"object"}}]}`
		case "tools/call":
			args, _ := req.Params["arguments"].(map[string]any)
			query, _ := args["query"].(string)
			result = `{"content":[{"type":"text","text":"result for ` + query + `"}],"isError":false}`
		default:
			http.Error(w, "unknown method", http.StatusBadRequest)
			return
		}
		w.Header().Set("Mcp-Session-Id", "sess-1")
		envelope := `{"jsonrpc":"2.0","id":` + strconv.FormatInt(req.ID, 10) + `,"result":` + result + `}`
		if sse {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "event: message\ndata: "+envelope+"\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, envelope)
	}))
}

func TestService_discoversAllowlistedToolsAndCalls_JSON(t *testing.T) {
	srv := jsonrpcServer(t, false)
	defer srv.Close()
	assertServiceWorks(t, srv.URL)
}

func TestService_discoversAllowlistedToolsAndCalls_SSE(t *testing.T) {
	srv := jsonrpcServer(t, true)
	defer srv.Close()
	assertServiceWorks(t, srv.URL)
}

func assertServiceWorks(t *testing.T, url string) {
	t.Helper()
	svc := NewService(map[string]ServerConfig{
		"tavily": {URL: url, Tools: []string{"tavily_search"}},
	}, nil)

	tools, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	// Allowlist excludes "extract"; only tavily_search survives, namespaced.
	if len(tools) != 1 || tools[0].Function.Name != "tavily__tavily_search" {
		t.Fatalf("tools = %+v", tools)
	}

	out, err := svc.Call(context.Background(), "tavily__tavily_search", map[string]any{"query": "sandman"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if !strings.Contains(out, "result for sandman") {
		t.Fatalf("call output = %q", out)
	}

	if _, err := svc.Call(context.Background(), "nope__missing", nil); err == nil {
		t.Fatal("expected error for unknown tool")
	}
}

func TestService_allDiscoveryFailingReturnsErrorAndRetries(t *testing.T) {
	// The server is down at first, then recovers. A failed discovery must NOT be
	// cached — otherwise a transient outage silently disables research for the
	// whole process (violating the "no degraded no-search mode" guarantee).
	var healthy atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healthy.Load() {
			http.Error(w, "down", http.StatusInternalServerError)
			return
		}
		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &req)
		result := `{}`
		if req.Method == "tools/list" {
			result = `{"tools":[{"name":"tavily_search","description":"x","inputSchema":{}}]}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":`+strconv.FormatInt(req.ID, 10)+`,"result":`+result+`}`)
	}))
	defer srv.Close()

	svc := NewService(map[string]ServerConfig{"tavily": {URL: srv.URL, Tools: []string{"tavily_search"}}}, nil)

	// First call: every server failed → error, and nothing cached.
	if _, err := svc.Tools(context.Background()); err == nil {
		t.Fatal("expected error when all discovery fails")
	}

	// Server recovers; a retry must now succeed (proving the failure was not cached).
	healthy.Store(true)
	tools, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("retry after recovery: %v", err)
	}
	if len(tools) != 1 || tools[0].Function.Name != "tavily__tavily_search" {
		t.Fatalf("tools after recovery = %+v", tools)
	}
}

func TestService_skipsServerThatFailsDiscovery(t *testing.T) {
	good := jsonrpcServer(t, false)
	defer good.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	defer bad.Close()

	svc := NewService(map[string]ServerConfig{
		"tavily": {URL: good.URL, Tools: []string{"tavily_search"}},
		"fetch":  {URL: bad.URL, Tools: []string{"fetch"}},
	}, nil)
	tools, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	// The bad server is skipped; the good one still contributes its tool.
	if len(tools) != 1 || tools[0].Function.Name != "tavily__tavily_search" {
		t.Fatalf("expected only tavily tool, got %+v", tools)
	}
}
