package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/llm"
)

// scriptedChat returns queued responses in order; it records whether each call
// was made with tools available.
type scriptedChat struct {
	replies     []llm.Message
	calls       int
	toolsOnLast bool
}

func (s *scriptedChat) Chat(_ context.Context, _ []llm.Message, tools []llm.Tool) (llm.Message, error) {
	s.toolsOnLast = len(tools) > 0
	r := s.replies[s.calls]
	s.calls++
	return r, nil
}

// fakeTools advertises one tool and records dispatched calls.
type fakeTools struct {
	called [][2]string // {name, argJSON}
}

func (f *fakeTools) Tools(context.Context) ([]llm.Tool, error) {
	return []llm.Tool{{Type: "function", Function: llm.ToolFunction{Name: "tavily__tavily_search"}}}, nil
}
func (f *fakeTools) Call(_ context.Context, name string, args map[string]any) (string, error) {
	q, _ := args["query"].(string)
	f.called = append(f.called, [2]string{name, q})
	return "search result about the song", nil
}

func toolCallMsg(name, args string) llm.Message {
	return llm.Message{Role: "assistant", ToolCalls: []llm.ToolCall{
		{ID: "c1", Type: "function", Function: llm.ToolCallFunction{Name: name, Arguments: args}},
	}}
}

func TestRunResearch_dispatchesToolThenReturnsFinalContent(t *testing.T) {
	chat := &scriptedChat{replies: []llm.Message{
		toolCallMsg("tavily__tavily_search", `{"query":"enter sandman"}`),
		{Role: "assistant", Content: `{"final":"answer"}`},
	}}
	tools := &fakeTools{}

	var progress []Progress
	out, err := runResearch(context.Background(), chat, tools, "sys", "Metallica, Enter Sandman",
		func(p Progress) { progress = append(progress, p) })
	if err != nil {
		t.Fatalf("runResearch: %v", err)
	}
	if out != `{"final":"answer"}` {
		t.Fatalf("out = %q", out)
	}
	if len(tools.called) != 1 || tools.called[0][0] != "tavily__tavily_search" || tools.called[0][1] != "enter sandman" {
		t.Fatalf("tool dispatch = %+v", tools.called)
	}
	// Progress must surface the actual search query and end on composing.
	var sawSearch, sawCompose bool
	for _, p := range progress {
		if p.Phase == "researching" && strings.Contains(p.Detail, "enter sandman") {
			sawSearch = true
		}
		if p.Phase == "composing" {
			sawCompose = true
		}
	}
	if !sawSearch || !sawCompose {
		t.Fatalf("progress = %+v", progress)
	}
}

// alwaysToolsChat keeps requesting tools until it is offered none (the forced
// final-answer turn), then returns content.
type alwaysToolsChat struct {
	rounds     int
	sawNoTools bool
}

func (a *alwaysToolsChat) Chat(_ context.Context, _ []llm.Message, tools []llm.Tool) (llm.Message, error) {
	if len(tools) == 0 {
		a.sawNoTools = true
		return llm.Message{Role: "assistant", Content: `{"forced":"final"}`}, nil
	}
	a.rounds++
	return toolCallMsg("tavily__tavily_search", `{"query":"x"}`), nil
}

func TestRunResearch_forcesFinalAnswerAfterRoundCap(t *testing.T) {
	chat := &alwaysToolsChat{}
	out, err := runResearch(context.Background(), chat, &fakeTools{}, "sys", "ref", nil)
	if err != nil {
		t.Fatalf("runResearch: %v", err)
	}
	if out != `{"forced":"final"}` {
		t.Fatalf("out = %q", out)
	}
	if chat.rounds != maxToolRounds {
		t.Fatalf("expected exactly %d tool rounds, got %d", maxToolRounds, chat.rounds)
	}
	if !chat.sawNoTools {
		t.Fatal("final turn must be made with no tools available")
	}
}
