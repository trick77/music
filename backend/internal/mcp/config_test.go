package mcp

import (
	"net/url"
	"testing"
)

// Tavily authenticates via a query parameter, so the key must land in the URL —
// and the allowlist must pin the server to tavily_search only (extract/map/crawl
// are deliberately not exposed to the model).
func TestTavilyServerConfig_putsKeyInQueryAndPinsAllowlist(t *testing.T) {
	cfg := TavilyServerConfig("", "secret-key")

	u, err := url.Parse(cfg.URL)
	if err != nil {
		t.Fatalf("config URL is unparseable: %v", err)
	}
	if got := u.Query().Get("tavilyApiKey"); got != "secret-key" {
		t.Errorf("tavilyApiKey = %q, want %q", got, "secret-key")
	}
	// Empty base URL falls back to the hosted endpoint.
	if u.Host != "mcp.tavily.com" {
		t.Errorf("default host = %q, want mcp.tavily.com", u.Host)
	}
	if len(cfg.Tools) != 1 || cfg.Tools[0] != tavilySearchTool {
		t.Errorf("Tools = %v, want only %q", cfg.Tools, tavilySearchTool)
	}
	if cfg.InProcess {
		t.Error("Tavily is a remote server, InProcess must be false")
	}
}

// A self-hosted base URL must be honoured, and its existing query parameters
// must survive the key being added.
func TestTavilyServerConfig_preservesCustomBaseAndExistingQuery(t *testing.T) {
	cfg := TavilyServerConfig("https://tavily.internal/mcp/?region=eu", "k")

	u, err := url.Parse(cfg.URL)
	if err != nil {
		t.Fatalf("config URL is unparseable: %v", err)
	}
	if u.Host != "tavily.internal" || u.Path != "/mcp/" {
		t.Errorf("custom base not honoured: %q", cfg.URL)
	}
	q := u.Query()
	if q.Get("region") != "eu" {
		t.Errorf("existing query parameter dropped: %q", cfg.URL)
	}
	if q.Get("tavilyApiKey") != "k" {
		t.Errorf("tavilyApiKey missing: %q", cfg.URL)
	}
}

// Whitespace is not a base URL; it must fall back to the hosted endpoint rather
// than producing a URL the client can never dial.
func TestTavilyServerConfig_blankBaseFallsBackToDefault(t *testing.T) {
	cfg := TavilyServerConfig("   ", "k")
	u, err := url.Parse(cfg.URL)
	if err != nil || u.Host != "mcp.tavily.com" {
		t.Fatalf("blank base should use the hosted endpoint, got %q (err %v)", cfg.URL, err)
	}
}

// A key with URL-special characters must be escaped, not injected raw — an
// unescaped '&' would silently truncate the key.
func TestTavilyServerConfig_escapesSpecialCharactersInKey(t *testing.T) {
	cfg := TavilyServerConfig("", "a&b=c d")
	u, err := url.Parse(cfg.URL)
	if err != nil {
		t.Fatalf("config URL is unparseable: %v", err)
	}
	if got := u.Query().Get("tavilyApiKey"); got != "a&b=c d" {
		t.Errorf("key round-trip = %q, want %q", got, "a&b=c d")
	}
}

// Fetch runs in-process, so it must carry no URL and be flagged InProcess —
// that flag is what routes it to the in-process client instead of a dialer.
func TestFetchServerConfig_isInProcessWithNoURL(t *testing.T) {
	cfg := FetchServerConfig()
	if !cfg.InProcess {
		t.Error("fetch must be InProcess")
	}
	if cfg.URL != "" {
		t.Errorf("in-process server must have no URL, got %q", cfg.URL)
	}
	if len(cfg.Tools) != 1 || cfg.Tools[0] != fetchTool {
		t.Errorf("Tools = %v, want only %q", cfg.Tools, fetchTool)
	}
}

func TestExposedToolName(t *testing.T) {
	if got := ExposedToolName("tavily", "tavily_search"); got != "tavily__tavily_search" {
		t.Errorf("ExposedToolName = %q", got)
	}
}
