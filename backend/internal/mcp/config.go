// Package mcp is a minimal MCP (Model Context Protocol) client over the
// streamable-HTTP transport, used by Studio to reach the Tavily web-search and
// web-fetch servers. It is a trimmed remote-only port of the client in ../loom
// (no stdio, no obscura, no categories/status).
package mcp

import (
	"net/url"
	"strings"
)

const (
	// defaultTavilyURL is the hosted Tavily MCP endpoint used when no base URL is given.
	defaultTavilyURL = "https://mcp.tavily.com/mcp/"
	// tavilySearchTool is the only Tavily tool Studio exposes (extract/map/crawl filtered out).
	tavilySearchTool = "tavily_search"
	// fetchTool is the web-fetch server's tool name.
	fetchTool = "fetch"
)

// ServerConfig describes one remote MCP server.
type ServerConfig struct {
	URL     string
	Headers map[string]string
	// Tools is an optional allowlist of server-side tool names. Empty exposes all.
	Tools []string
}

// ExposedToolName namespaces a server-side tool as serverName__toolName so the
// model (and the dispatcher) can route it back to the right server.
func ExposedToolName(serverName, toolName string) string {
	return serverName + "__" + toolName
}

// TavilyServerConfig builds the Tavily search server config. Auth uses Tavily's
// documented query parameter (?tavilyApiKey=...), so the key lives in the URL and
// must be scrubbed from any error before logging (see scrubURLError).
func TavilyServerConfig(baseURL, apiKey string) ServerConfig {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = defaultTavilyURL
	}
	cfg := ServerConfig{Tools: []string{tavilySearchTool}}
	if u, err := url.Parse(baseURL); err == nil {
		q := u.Query()
		q.Set("tavilyApiKey", apiKey)
		u.RawQuery = q.Encode()
		cfg.URL = u.String()
		return cfg
	}
	sep := "?"
	if strings.Contains(baseURL, "?") {
		sep = "&"
	}
	cfg.URL = baseURL + sep + "tavilyApiKey=" + url.QueryEscape(apiKey)
	return cfg
}

// FetchServerConfig builds the web-fetch server config.
func FetchServerConfig(rawURL string) ServerConfig {
	return ServerConfig{URL: rawURL, Tools: []string{fetchTool}}
}
