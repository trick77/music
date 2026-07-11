package mcp

import (
	"context"

	"github.com/trick77/webfetch"
)

// fetchClientDescription is copied verbatim from the upstream mcp-server-fetch
// tool so the model sees the identical tool description it did when fetch ran as
// a sidecar.
const fetchClientDescription = `Fetches a URL from the internet and optionally extracts its contents as markdown.

Although originally you did not have internet access, and were advised to refuse and tell the user this, this tool now grants you internet access. Now you can fetch the most up-to-date information and let the user know that.`

// fetchClient is an in-process client that replaces the external web-fetch MCP
// sidecar. It performs the fetch directly via the shared
// github.com/trick77/webfetch module (a faithful Go port of mcp-server-fetch),
// so no separate container, Python runtime, or stdio bridge is required. It
// exposes exactly one tool, "fetch" (as "fetch__fetch"), with the same schema
// and behaviour the sidecar did.
type fetchClient struct {
	serverName string
}

func newFetchClient(serverName string) *fetchClient {
	return &fetchClient{serverName: serverName}
}

func (c *fetchClient) listTools(context.Context) ([]Tool, error) {
	return []Tool{{
		Name:         ExposedToolName(c.serverName, fetchTool),
		OriginalName: fetchTool,
		Description:  fetchClientDescription,
		ServerName:   c.serverName,
		// Schema matches the JSON Schema upstream's pydantic model emits.
		InputSchema: map[string]any{
			"type":  "object",
			"title": "Fetch",
			"properties": map[string]any{
				"url": map[string]any{
					"description": "URL to fetch",
					"format":      "uri",
					"minLength":   1,
					"title":       "Url",
					"type":        "string",
				},
				"max_length": map[string]any{
					"default":          5000,
					"description":      "Maximum number of characters to return.",
					"exclusiveMaximum": 1000000,
					"exclusiveMinimum": 0,
					"title":            "Max Length",
					"type":             "integer",
				},
				"start_index": map[string]any{
					"default":     0,
					"description": "On return output starting at this character index, useful if a previous fetch was truncated and more context is required.",
					"minimum":     0,
					"title":       "Start Index",
					"type":        "integer",
				},
				"raw": map[string]any{
					"default":     false,
					"description": "Get the actual HTML content of the requested page, without simplification.",
					"title":       "Raw",
					"type":        "boolean",
				},
			},
			"required": []any{"url"},
		},
	}}, nil
}

func (c *fetchClient) callTool(ctx context.Context, name string, arguments map[string]any) (string, error) {
	url, _ := arguments["url"].(string)
	return webfetch.Fetch(ctx, url, webfetch.Options{
		MaxLength:  argInt(arguments, "max_length"),
		StartIndex: argInt(arguments, "start_index"),
		Raw:        argBool(arguments, "raw"),
	})
}

// argInt coerces a JSON tool argument (which arrives as float64) to an int.
// Missing/non-numeric yields 0, which webfetch.Fetch treats as the default.
func argInt(args map[string]any, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	}
	return 0
}

// argBool coerces a JSON tool argument to a bool; missing/non-bool yields false.
func argBool(args map[string]any, key string) bool {
	b, _ := args[key].(bool)
	return b
}
