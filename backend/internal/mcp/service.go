package mcp

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/trick77/music/internal/llm"
)

// perCallTimeout bounds each individual tool call.
const perCallTimeout = 30 * time.Second

// Service routes tool calls to the right remote MCP server. Tool discovery is
// lazy (first Tools call) so server boot never blocks on an MCP endpoint; a
// server that fails discovery is skipped and the rest still work.
type Service struct {
	clients    map[string]*remoteClient
	httpClient *http.Client

	mu         sync.Mutex
	discovered bool
	tools      []llm.Tool
	routes     map[string]route
}

type route struct {
	client       *remoteClient
	originalName string
}

// NewService builds a Service for the given servers (name -> config). Nil/empty
// yields a Service whose Tools returns nothing.
func NewService(servers map[string]ServerConfig, httpClient *http.Client) *Service {
	clients := make(map[string]*remoteClient, len(servers))
	for name, cfg := range servers {
		clients[name] = newRemoteClient(name, cfg, httpClient)
	}
	return &Service{clients: clients, httpClient: httpClient}
}

// Tools returns the OpenAI-shaped tools exposed by every reachable server,
// discovering (and caching) them on first call.
func (s *Service) Tools(ctx context.Context) ([]llm.Tool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.discovered {
		return s.tools, nil
	}
	routes := make(map[string]route)
	var tools []llm.Tool
	names := make([]string, 0, len(s.clients))
	for name := range s.clients {
		names = append(names, name)
	}
	sort.Strings(names) // deterministic tool order
	failures := 0
	for _, name := range names {
		client := s.clients[name]
		discovered, err := client.listTools(ctx)
		if err != nil {
			// A server that fails discovery is skipped (a down fetch server must
			// not sink search). But if EVERY server fails, that is surfaced below.
			slog.Warn("studio mcp: tool discovery failed", "server", name, "error", err)
			failures++
			continue
		}
		for _, t := range discovered {
			routes[t.Name] = route{client: client, originalName: t.OriginalName}
			tools = append(tools, llm.Tool{
				Type: "function",
				Function: llm.ToolFunction{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  t.InputSchema,
				},
			})
		}
	}
	// Do not cache a total discovery failure: a transient outage would otherwise
	// permanently disable research for the process (the config gate promises no
	// degraded no-search mode). Surface the error so the request fails and the
	// next one retries fresh.
	if len(tools) == 0 && len(s.clients) > 0 {
		return nil, fmt.Errorf("studio: no research tools available (all %d MCP server(s) failed discovery)", failures)
	}
	s.routes = routes
	s.tools = tools
	s.discovered = true
	return s.tools, nil
}

// Call dispatches an exposed tool name to its server under a bounded timeout.
func (s *Service) Call(ctx context.Context, name string, args map[string]any) (string, error) {
	s.mu.Lock()
	r, ok := s.routes[name]
	s.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("unknown tool %q", name)
	}
	callCtx, cancel := context.WithTimeout(ctx, perCallTimeout)
	defer cancel()
	return r.client.callTool(callCtx, r.originalName, args)
}
