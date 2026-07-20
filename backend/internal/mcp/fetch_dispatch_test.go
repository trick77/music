package mcp

import (
	"context"
	"strings"
	"testing"
)

// Tool arguments arrive from JSON, so every number is a float64. Coercing them
// wrongly would silently send max_length=0 (the "use the default" sentinel) and
// quietly truncate every fetch.
func TestArgCoercion(t *testing.T) {
	args := map[string]any{
		"max_length":        float64(12000),
		"start_index":       float64(500),
		"int_native":        7,
		"int64_native":      int64(9),
		"raw":               true,
		"not_bool":          "true",
		"selector":          "article",
		"not_string":        42,
		"exclude_selectors": []any{"nav", "", ".cookie", 7, ".ad"},
		"not_a_slice":       "nav",
	}

	t.Run("argInt", func(t *testing.T) {
		cases := map[string]int{
			"max_length":   12000,
			"start_index":  500,
			"int_native":   7,
			"int64_native": 9,
			"raw":          0, // wrong type falls back to the default sentinel
			"missing":      0,
		}
		for key, want := range cases {
			if got := argInt(args, key); got != want {
				t.Errorf("argInt(%q) = %d, want %d", key, got, want)
			}
		}
	})

	t.Run("argBool", func(t *testing.T) {
		if !argBool(args, "raw") {
			t.Error("argBool(raw) = false, want true")
		}
		// A string "true" is not a bool and must not be treated as one.
		if argBool(args, "not_bool") {
			t.Error(`argBool("true" string) = true, want false`)
		}
		if argBool(args, "missing") {
			t.Error("argBool(missing) = true, want false")
		}
	})

	t.Run("argString", func(t *testing.T) {
		if got := argString(args, "selector"); got != "article" {
			t.Errorf("argString(selector) = %q", got)
		}
		if got := argString(args, "not_string"); got != "" {
			t.Errorf("argString(non-string) = %q, want empty", got)
		}
		if got := argString(args, "missing"); got != "" {
			t.Errorf("argString(missing) = %q, want empty", got)
		}
	})

	t.Run("argStringSlice", func(t *testing.T) {
		// Non-strings and empty entries are skipped; order is preserved.
		got := argStringSlice(args, "exclude_selectors")
		want := []string{"nav", ".cookie", ".ad"}
		if len(got) != len(want) {
			t.Fatalf("argStringSlice = %#v, want %#v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("argStringSlice = %#v, want %#v", got, want)
			}
		}
		if argStringSlice(args, "not_a_slice") != nil {
			t.Error("a non-array must yield nil")
		}
		if argStringSlice(args, "missing") != nil {
			t.Error("a missing key must yield nil")
		}
	})
}

// The in-process fetch client must surface a fetch failure as an error rather
// than an empty string, so the loop can report "tool error" back to the model.
//
// webfetch's SSRF guard restricts outbound connections to public IPs, so a
// loopback URL is rejected before any connection is attempted — deterministic
// and offline.
func TestFetchClient_callToolReturnsErrorForRejectedURL(t *testing.T) {
	c := newFetchClient("fetch")
	out, err := c.callTool(context.Background(), fetchTool, map[string]any{
		"url":        "http://127.0.0.1:1/",
		"max_length": float64(100),
	})
	if err == nil {
		t.Fatalf("expected an error for a blocked URL, got output %q", out)
	}
	if out != "" {
		t.Errorf("a failed fetch must return no output, got %q", out)
	}
}

// A missing/malformed url argument must fail rather than fetching "".
func TestFetchClient_callToolRejectsMissingURL(t *testing.T) {
	c := newFetchClient("fetch")
	for _, args := range []map[string]any{
		{},                   // no url at all
		{"url": 42},          // wrong type
		{"url": "not-a-url"}, // unusable
		{"url": "ftp://x/y"}, // unsupported scheme
	} {
		if _, err := c.callTool(context.Background(), fetchTool, args); err == nil {
			t.Errorf("expected an error for args %#v", args)
		}
	}
}

// The fetch tool must be namespaced and described, since both are what the model
// sees when deciding whether to call it.
func TestFetchClient_toolIsNamespacedAndDescribed(t *testing.T) {
	tools, err := newFetchClient("fetch").listTools(context.Background())
	if err != nil {
		t.Fatalf("listTools: %v", err)
	}
	tool := tools[0]
	if tool.Name != "fetch__fetch" {
		t.Errorf("Name = %q, want fetch__fetch", tool.Name)
	}
	if tool.OriginalName != fetchTool || tool.ServerName != "fetch" {
		t.Errorf("routing fields wrong: %+v", tool)
	}
	if !strings.Contains(tool.Description, "markdown") {
		t.Errorf("description should tell the model what it gets back: %q", tool.Description)
	}
	// url is the one required argument.
	req, _ := tool.InputSchema["required"].([]any)
	if len(req) != 1 || req[0] != "url" {
		t.Errorf("required = %#v, want [url]", req)
	}
}

// An InProcess server config must route to the in-process fetch client, with no
// URL dialled — that is the whole point of dropping the sidecar.
func TestNewService_routesInProcessServerToFetchClient(t *testing.T) {
	svc := NewService(map[string]ServerConfig{"fetch": FetchServerConfig()}, nil)

	client, ok := svc.clients["fetch"]
	if !ok {
		t.Fatal("fetch server missing from the service")
	}
	if _, isFetch := client.(*fetchClient); !isFetch {
		t.Fatalf("InProcess server got %T, want *fetchClient", client)
	}

	// Discovery must work with no network at all.
	tools, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	if len(tools) != 1 || tools[0].Function.Name != "fetch__fetch" {
		t.Fatalf("tools = %+v", tools)
	}
}

// A remote server config must NOT be routed in-process.
func TestNewService_routesRemoteServerToRemoteClient(t *testing.T) {
	svc := NewService(map[string]ServerConfig{
		"tavily": TavilyServerConfig("https://example.invalid/mcp/", "k"),
	}, nil)
	if _, isRemote := svc.clients["tavily"].(*remoteClient); !isRemote {
		t.Fatalf("remote server got %T, want *remoteClient", svc.clients["tavily"])
	}
}

// No servers configured means no tools — and, critically, no error: Studio must
// still boot with research disabled.
func TestNewService_withNoServersYieldsNoToolsAndNoError(t *testing.T) {
	for _, servers := range []map[string]ServerConfig{nil, {}} {
		svc := NewService(servers, nil)
		tools, err := svc.Tools(context.Background())
		if err != nil {
			t.Fatalf("Tools with no servers should not error: %v", err)
		}
		if len(tools) != 0 {
			t.Fatalf("tools = %+v, want none", tools)
		}
	}
}

// Discovery is cached: a second Tools call must not re-dial every server.
func TestService_cachesSuccessfulDiscovery(t *testing.T) {
	svc := NewService(map[string]ServerConfig{"fetch": FetchServerConfig()}, nil)
	first, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools: %v", err)
	}
	second, err := svc.Tools(context.Background())
	if err != nil {
		t.Fatalf("Tools (cached): %v", err)
	}
	if len(first) != len(second) {
		t.Fatalf("cached discovery changed the tool list: %d vs %d", len(first), len(second))
	}
	if !svc.discovered {
		t.Error("a successful discovery must be cached")
	}
}
