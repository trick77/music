package studio

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/url"
	"strings"

	"github.com/trick77/music/internal/llm"
)

// maxToolRounds bounds the research loop: after this many tool-calling rounds, a
// tool-free final turn forces the model to answer. It is deliberately tight —
// the only thing left to research is what THIS song sounds like (the Suno tag
// vocabulary is static, see sunoTagReference), which is a search and a fetch or
// two. Every extra round the model takes is wait time the user watches.
const maxToolRounds = 4

// toolProvider is the subset of mcp.Service the loop needs (fakeable in tests).
type toolProvider interface {
	Tools(ctx context.Context) ([]llm.Tool, error)
	Call(ctx context.Context, name string, args map[string]any) (string, error)
}

// runResearch drives an agentic loop: the model may call web tools up to
// maxToolRounds times to research the reference, then returns its final text
// AND the conversation that produced it. The history matters: the later generate
// turns continue this same conversation, so the research and every earlier answer
// stay in context instead of being squeezed into a hand-off summary.
// It emits progress so the UI can show what is happening.
func runResearch(ctx context.Context, chat llm.Chat, tools toolProvider, system, user string, onProgress ProgressFunc) (string, []llm.Message, error) {
	messages := []llm.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
	}
	toolList, err := tools.Tools(ctx)
	if err != nil {
		return "", nil, err
	}

	onProgress.emit(Progress{Phase: "thinking", Detail: "Studying the song"})
	for round := 0; round < maxToolRounds; round++ {
		resp, err := chat.Chat(ctx, messages, toolList)
		if err != nil {
			return "", nil, err
		}
		if len(resp.ToolCalls) == 0 {
			onProgress.emit(Progress{Phase: "composing", Detail: "Composing the Suno prompt"})
			return resp.Content, append(messages, resp), nil
		}
		messages = append(messages, resp)
		for _, tc := range resp.ToolCalls {
			args := parseToolArgs(tc.Function.Arguments)
			onProgress.emit(toolProgress(tc.Function.Name, args))
			out, callErr := tools.Call(ctx, tc.Function.Name, args)
			if callErr != nil {
				slog.Warn("studio: tool call failed", "tool", tc.Function.Name, "err", callErr)
				out = "tool error: " + callErr.Error()
			}
			messages = append(messages, llm.Message{Role: "tool", ToolCallID: tc.ID, Content: out})
		}
	}

	// Round cap reached: force a tool-free final answer.
	onProgress.emit(Progress{Phase: "composing", Detail: "Composing the Suno prompt"})
	messages = append(messages, llm.Message{
		Role:    "user",
		Content: "Stop researching now and output only the JSON answer this turn asked for. Do not call any tools.",
	})
	resp, err := chat.Chat(ctx, messages, nil)
	if err != nil {
		return "", nil, err
	}
	return resp.Content, append(messages, resp), nil
}

// runTurn continues an existing conversation with one tool-free turn: it appends
// the user message, asks once, and returns the reply plus the extended history so
// the next turn can build on it. The research already happened in runResearch, so
// no tools are advertised here — the model answers from what is already in view.
func runTurn(ctx context.Context, chat llm.Chat, history []llm.Message, user string) (string, []llm.Message, error) {
	// Copy rather than append in place: the caller's history may share a backing
	// array with an earlier turn, and a second append would overwrite it.
	messages := make([]llm.Message, 0, len(history)+2)
	messages = append(messages, history...)
	messages = append(messages, llm.Message{Role: "user", Content: user})
	resp, err := chat.Chat(ctx, messages, nil)
	if err != nil {
		return "", nil, err
	}
	return resp.Content, append(messages, resp), nil
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
