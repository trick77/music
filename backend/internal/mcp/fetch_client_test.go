package mcp

import (
	"context"
	"testing"
)

func TestFetchClientAdvertisesFetchTool(t *testing.T) {
	tools, err := newFetchClient("fetch").listTools(context.Background())
	if err != nil {
		t.Fatalf("listTools error: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("listTools returned %d tools, want 1", len(tools))
	}
	props, ok := tools[0].InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("InputSchema properties missing: %#v", tools[0].InputSchema)
	}
	for _, key := range []string{"url", "max_length", "start_index", "raw", "extract_pdf", "include_metadata", "full_page", "selector", "exclude_selectors"} {
		if _, ok := props[key]; !ok {
			t.Errorf("InputSchema missing property %q", key)
		}
	}
}
