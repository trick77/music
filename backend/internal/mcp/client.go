package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultHTTPTimeout  = 15 * time.Second
	maxRPCResponseBytes = 4 << 20
	maxToolOutputBytes  = 32 << 10
)

// Tool is a server-side tool discovered via tools/list, namespaced for exposure.
type Tool struct {
	Name         string // exposed name: server__tool
	OriginalName string
	Description  string
	InputSchema  map[string]any
	ServerName   string
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type listToolsResult struct {
	Tools []toolResult `json:"tools"`
}

type toolResult struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type callToolResult struct {
	Content []toolContent `json:"content"`
	IsError bool          `json:"isError"`
}

type toolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// remoteClient speaks JSON-RPC 2.0 over the streamable-HTTP transport to one server.
type remoteClient struct {
	serverName string
	cfg        ServerConfig
	httpClient *http.Client
	nextID     atomic.Int64
	initMu     sync.Mutex
	inited     bool
	mu         sync.Mutex
	sessionID  string
}

func newRemoteClient(serverName string, cfg ServerConfig, httpClient *http.Client) *remoteClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	return &remoteClient{serverName: serverName, cfg: cfg, httpClient: httpClient}
}

func (c *remoteClient) listTools(ctx context.Context) ([]Tool, error) {
	var result listToolsResult
	if err := c.callWithSession(ctx, "tools/list", nil, &result); err != nil {
		return nil, err
	}
	out := make([]Tool, 0, len(result.Tools))
	for _, t := range result.Tools {
		if !c.toolAllowed(t.Name) {
			continue
		}
		out = append(out, Tool{
			Name:         ExposedToolName(c.serverName, t.Name),
			OriginalName: t.Name,
			Description:  t.Description,
			InputSchema:  t.InputSchema,
			ServerName:   c.serverName,
		})
	}
	return out, nil
}

func (c *remoteClient) callTool(ctx context.Context, name string, arguments map[string]any) (string, error) {
	var result callToolResult
	if err := c.callWithSession(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments}, &result); err != nil {
		return "", err
	}
	if result.IsError {
		return "", fmt.Errorf("MCP tool %q returned an error: %s", name, toolContentText(result.Content))
	}
	return toolContentText(result.Content), nil
}

func (c *remoteClient) toolAllowed(name string) bool {
	if len(c.cfg.Tools) == 0 {
		return true
	}
	for _, allowed := range c.cfg.Tools {
		if allowed == name {
			return true
		}
	}
	return false
}

// mcpStatusError carries a non-2xx HTTP response so session errors can be distinguished.
type mcpStatusError struct {
	method string
	status int
	body   string
}

func (e *mcpStatusError) Error() string {
	return fmt.Sprintf("MCP %s failed with status %d: %s", e.method, e.status, e.body)
}

// isSessionError reports an expired/invalid streamable-HTTP session (recoverable
// by re-initializing). Servers reject with 400/404 mentioning the session.
func isSessionError(err error) bool {
	var statusErr *mcpStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	if statusErr.status != http.StatusBadRequest && statusErr.status != http.StatusNotFound {
		return false
	}
	return strings.Contains(strings.ToLower(statusErr.body), "session")
}

func (c *remoteClient) callWithSession(ctx context.Context, method string, params, out any) error {
	if err := c.initialize(ctx); err != nil {
		return err
	}
	err := c.call(ctx, method, params, out)
	if err == nil || !isSessionError(err) {
		return err
	}
	c.resetSession()
	if err := c.initialize(ctx); err != nil {
		return err
	}
	return c.call(ctx, method, params, out)
}

func (c *remoteClient) initialize(ctx context.Context) error {
	c.initMu.Lock()
	defer c.initMu.Unlock()
	if c.inited {
		return nil
	}
	if err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "music-studio", "version": "dev"},
	}, nil); err != nil {
		return err
	}
	c.inited = true
	return nil
}

func (c *remoteClient) resetSession() {
	c.initMu.Lock()
	c.inited = false
	c.initMu.Unlock()
	c.mu.Lock()
	c.sessionID = ""
	c.mu.Unlock()
}

func (c *remoteClient) call(ctx context.Context, method string, params any, out any) error {
	id := c.nextID.Add(1)
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// The streamable-HTTP transport mandates clients accept both content types;
	// spec-compliant servers answer 406 otherwise and may reply with SSE.
	req.Header.Set("Accept", "application/json, text/event-stream")
	c.mu.Lock()
	sessionID := c.sessionID
	c.mu.Unlock()
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}
	for key, value := range c.cfg.Headers {
		req.Header.Set(key, value)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return scrubURLError(err)
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &mcpStatusError{method: method, status: resp.StatusCode, body: strings.TrimSpace(string(snippet))}
	}
	rpcResp, err := decodeRPCResponse(resp, id)
	if err != nil {
		return err
	}
	if rpcResp.Error != nil {
		return fmt.Errorf("MCP %s failed: %s", method, rpcResp.Error.Message)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(rpcResp.Result, out)
}

// decodeRPCResponse reads a JSON-RPC reply from either a bare JSON body or an SSE body.
func decodeRPCResponse(resp *http.Response, id int64) (rpcResponse, error) {
	limited := io.LimitReader(resp.Body, maxRPCResponseBytes)
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return decodeSSEResponse(limited, id)
	}
	var rpcResp rpcResponse
	if err := json.NewDecoder(limited).Decode(&rpcResp); err != nil {
		return rpcResponse{}, err
	}
	return rpcResp, nil
}

// decodeSSEResponse returns the first JSON-RPC message in an SSE stream whose id matches.
func decodeSSEResponse(r io.Reader, id int64) (rpcResponse, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRPCResponseBytes)
	var data strings.Builder
	flush := func() (rpcResponse, bool) {
		if data.Len() == 0 {
			return rpcResponse{}, false
		}
		raw := data.String()
		data.Reset()
		var rpcResp rpcResponse
		if err := json.Unmarshal([]byte(raw), &rpcResp); err != nil {
			return rpcResponse{}, false
		}
		return rpcResp, rpcResp.ID == id
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if rpcResp, ok := flush(); ok {
				return rpcResp, nil
			}
			continue
		}
		if value, found := strings.CutPrefix(line, "data:"); found {
			data.WriteString(strings.TrimPrefix(value, " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return rpcResponse{}, err
	}
	if rpcResp, ok := flush(); ok {
		return rpcResp, nil
	}
	return rpcResponse{}, fmt.Errorf("MCP response: no JSON-RPC message with id %d in SSE stream", id)
}

func toolContentText(content []toolContent) string {
	var b strings.Builder
	for _, item := range content {
		if item.Type != "text" || item.Text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		remaining := maxToolOutputBytes - b.Len()
		if remaining <= 0 {
			break
		}
		if len(item.Text) > remaining {
			b.WriteString(item.Text[:remaining])
			break
		}
		b.WriteString(item.Text)
	}
	return b.String()
}

// scrubURLError redacts the query string (which may carry ?tavilyApiKey=) and any
// userinfo from *url.Error values before they propagate into logs or errors.
func scrubURLError(err error) error {
	var urlErr *url.Error
	if !errors.As(err, &urlErr) {
		return err
	}
	if u, parseErr := url.Parse(urlErr.URL); parseErr == nil && u.Host != "" {
		u.RawQuery = ""
		u.User = nil
		urlErr.URL = u.String()
	}
	return urlErr
}
