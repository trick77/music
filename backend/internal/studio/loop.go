package studio

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/trick77/music/internal/llm"
)

// maxToolRounds bounds the research loop: after this many tool-calling rounds, a
// tool-free final turn forces the model to answer.
const maxToolRounds = 6

// toolProvider is the subset of mcp.Service the loop needs (fakeable in tests).
type toolProvider interface {
	Tools(ctx context.Context) ([]llm.Tool, error)
	Call(ctx context.Context, name string, args map[string]any) (string, error)
}

// runResearch drives an agentic loop: the model may call web tools up to
// maxToolRounds times to research the reference, then returns its final text.
// It emits progress so the UI can show what is happening.
func runResearch(ctx context.Context, chat llm.Chat, tools toolProvider, system, user string, onProgress ProgressFunc) (string, error) {
	messages := []llm.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
	toolList, err := tools.Tools(ctx)
	if err != nil {
		return "", err
	}

	onProgress.emit(Progress{Phase: "thinking", Detail: "Studying the song"})
	for round := 0; round < maxToolRounds; round++ {
		resp, err := chat.Chat(ctx, messages, toolList)
		if err != nil {
			return "", err
		}
		if len(resp.ToolCalls) == 0 {
			onProgress.emit(Progress{Phase: "composing", Detail: "Composing the Suno prompt"})
			return resp.Content, nil
		}
		messages = append(messages, resp)
		for _, tc := range resp.ToolCalls {
			args := parseToolArgs(tc.Function.Arguments)
			onProgress.emit(toolProgress(tc.Function.Name, args))
			out, callErr := tools.Call(ctx, tc.Function.Name, args)
			if callErr != nil {
				out = "tool error: " + callErr.Error()
			}
			messages = append(messages, llm.Message{Role: "tool", ToolCallID: tc.ID, Content: out})
		}
	}

	// Round cap reached: force a tool-free final answer.
	onProgress.emit(Progress{Phase: "composing", Detail: "Composing the Suno prompt"})
	messages = append(messages, llm.Message{
		Role:    "user",
		Content: "Stop researching now and output only the final JSON answer specified in the system prompt. Do not call any tools.",
	})
	resp, err := chat.Chat(ctx, messages, nil)
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}

// toolProgress renders a friendly progress line for a dispatched tool call.
func toolProgress(name string, args map[string]any) Progress {
	switch {
	case strings.Contains(name, "search"):
		if q, _ := args["query"].(string); q != "" {
			return Progress{Phase: "researching", Detail: "Searching the web for " + q}
		}
		return Progress{Phase: "researching", Detail: "Searching the web"}
	case strings.Contains(name, "fetch"):
		if raw, _ := args["url"].(string); raw != "" {
			if u, err := url.Parse(raw); err == nil && u.Host != "" {
				return Progress{Phase: "reading", Detail: "Reading " + u.Host}
			}
			return Progress{Phase: "reading", Detail: "Reading a page"}
		}
		return Progress{Phase: "reading", Detail: "Reading a page"}
	default:
		return Progress{Phase: "researching", Detail: "Gathering details"}
	}
}

// parseToolArgs decodes an OpenAI tool-call argument string into a map; a
// malformed or empty string yields an empty map so the call still proceeds.
func parseToolArgs(raw string) map[string]any {
	if raw == "" {
		return map[string]any{}
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return map[string]any{}
	}
	return args
}
