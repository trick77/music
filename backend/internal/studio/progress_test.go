package studio

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

// The progress line is the only thing the user sees while research runs, so each
// tool family must map to the right phase, and a URL must be reduced to its host
// (never the full URL, which is noise in a status line).
func TestToolProgress_mapsToolsToPhases(t *testing.T) {
	cases := []struct {
		name       string
		tool       string
		args       map[string]any
		wantPhase  string
		wantDetail string
	}{
		{"search with query", "tavily__tavily_search", map[string]any{"query": "enter sandman"},
			"researching", "Searching the web for enter sandman"},
		{"search without query", "tavily__tavily_search", map[string]any{},
			"researching", "Searching the web"},
		{"search with non-string query", "tavily__tavily_search", map[string]any{"query": 42},
			"researching", "Searching the web"},
		{"fetch shows host only", "fetch__fetch", map[string]any{"url": "https://en.wikipedia.org/wiki/Enter_Sandman"},
			"reading", "Reading en.wikipedia.org"},
		{"fetch with unparseable url", "fetch__fetch", map[string]any{"url": "not a url"},
			"reading", "Reading a page"},
		{"fetch without url", "fetch__fetch", map[string]any{},
			"reading", "Reading a page"},
		{"unknown tool", "something__else", map[string]any{},
			"researching", "Gathering details"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := toolProgress(tc.tool, tc.args)
			if got.Phase != tc.wantPhase || got.Detail != tc.wantDetail {
				t.Errorf("toolProgress(%q) = %+v, want {%s %s}", tc.tool, got, tc.wantPhase, tc.wantDetail)
			}
		})
	}
}

// Malformed tool arguments must never abort the loop: the call still proceeds
// with an empty map, so a single bad emission from the model is survivable.
func TestParseToolArgs_toleratesMalformedArguments(t *testing.T) {
	for _, raw := range []string{"", "not json", "{", `["a","b"]`, "null"} {
		got := parseToolArgs(raw)
		if len(got) != 0 {
			t.Errorf("parseToolArgs(%q) = %#v, want an empty map", raw, got)
		}
	}
	got := parseToolArgs(`{"query":"x","n":2}`)
	if got["query"] != "x" {
		t.Errorf("parseToolArgs lost a valid argument: %#v", got)
	}
}

// A failing tool must be reported back to the model as a tool result, not
// abort the run — the model can then try a different query or answer without it.
type failingTools struct{ fakeTools }

func (f *failingTools) Call(context.Context, string, map[string]any) (string, error) {
	return "", errors.New("tavily is down")
}

func TestRunResearch_feedsToolFailureBackToTheModel(t *testing.T) {
	chat := &capturingChat{replies: []llm.Message{
		toolCallMsg("tavily__tavily_search", `{"query":"x"}`),
		{Role: "assistant", Content: `{"final":"answer"}`},
	}}
	out, _, err := runResearch(context.Background(), chat, &failingTools{}, "sys", "ref", nil)
	if err != nil {
		t.Fatalf("a tool failure must not fail the run: %v", err)
	}
	if out != `{"final":"answer"}` {
		t.Fatalf("out = %q", out)
	}
	// The error must reach the model as a tool message so it can react.
	var sawToolError bool
	for _, m := range chat.lastMessages {
		if m.Role == "tool" && m.Content == "tool error: tavily is down" {
			sawToolError = true
		}
	}
	if !sawToolError {
		t.Fatalf("tool failure was not fed back to the model: %+v", chat.lastMessages)
	}
}

// capturingChat is scriptedChat plus a record of the final message list, so a
// test can assert what the model was actually shown.
type capturingChat struct {
	replies      []llm.Message
	calls        int
	lastMessages []llm.Message
}

func (c *capturingChat) Chat(_ context.Context, messages []llm.Message, _ []llm.Tool) (llm.Message, error) {
	c.lastMessages = messages
	r := c.replies[c.calls]
	c.calls++
	return r, nil
}

// Discovery failure must abort before any model call: running the research
// prompt with no tools would quietly produce an unresearched answer.
type brokenTools struct{ fakeTools }

func (b *brokenTools) Tools(context.Context) ([]llm.Tool, error) {
	return nil, errors.New("all MCP servers failed discovery")
}

func TestRunResearch_abortsWhenToolDiscoveryFails(t *testing.T) {
	chat := &capturingChat{replies: []llm.Message{{Role: "assistant", Content: "should never be reached"}}}
	if _, _, err := runResearch(context.Background(), chat, &brokenTools{}, "sys", "ref", nil); err == nil {
		t.Fatal("expected runResearch to fail when tool discovery fails")
	}
	if chat.calls != 0 {
		t.Fatalf("model was called %d times despite failed discovery", chat.calls)
	}
}

// errChat fails every completion.
type errChat struct{ err error }

func (e errChat) Chat(context.Context, []llm.Message, []llm.Tool) (llm.Message, error) {
	return llm.Message{}, e.err
}

func TestRunResearch_propagatesChatError(t *testing.T) {
	boom := errors.New("model unavailable")
	if _, _, err := runResearch(context.Background(), errChat{boom}, &fakeTools{}, "sys", "ref", nil); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// Refine must reject a reply it cannot turn into lyrics rather than handing the
// UI an empty lyrics box.
func TestRefine_rejectsUnusableReplies(t *testing.T) {
	cases := map[string]string{
		"no JSON object": "I would rather not.",
		"missing lyrics": `{"stylePrompt":"x"}`,
		"empty lyrics":   `{"lyrics":""}`,
		"wrong type":     `{"lyrics":42}`,
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			p := New(&cannedChat{reply: reply}, &fakeTools{})
			if _, err := p.Refine(context.Background(), RefineRequest{Reference: "r", Lyrics: "l", Instruction: "i"}, nil); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

func TestRefine_propagatesChatError(t *testing.T) {
	boom := errors.New("model unavailable")
	p := New(errChat{boom}, &fakeTools{})
	if _, err := p.Refine(context.Background(), RefineRequest{Reference: "r", Lyrics: "l", Instruction: "i"}, nil); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// Generate must reject a reply missing any of the three required fields — a
// half-filled result would reach the dialog as an empty box.
func TestGenerate_rejectsReplyMissingRequiredField(t *testing.T) {
	cases := map[string]string{
		"no style prompt": `{"lyrics":"[Verse]\nx","coverArtPrompt":"y"}`,
		"no lyrics":       `{"stylePrompt":"x","coverArtPrompt":"y"}`,
		"no cover art":    `{"stylePrompt":"x","lyrics":"[Verse]\ny"}`,
		"wrong types":     `{"stylePrompt":1,"lyrics":2,"coverArtPrompt":3}`,
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			p := New(&cannedChat{reply: reply}, &fakeTools{})
			if _, err := p.Generate(context.Background(), GenerateRequest{Reference: "x"}, nil, nil); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

// The playlist-description flow must surface a transport failure and a reply it
// cannot parse, rather than writing empty descriptions onto a playlist.
func TestPlaylistDescriptions_rejectsUnusableReplies(t *testing.T) {
	boom := errors.New("model unavailable")
	if _, err := NewDescriptionWriter(fakeChat{err: boom}).PlaylistDescriptions(context.Background(), "P", nil); !errors.Is(err, boom) {
		t.Errorf("err = %v, want %v", err, boom)
	}
	for name, reply := range map[string]string{
		"no JSON object": "Sorry, no.",
		"wrong types":    `{"punchy":1,"evocative":2,"factual":3}`,
		"all blank":      `{"punchy":"  ","evocative":"  ","factual":"  "}`,
	} {
		t.Run(name, func(t *testing.T) {
			w := NewDescriptionWriter(fakeChat{reply: reply})
			if _, err := w.PlaylistDescriptions(context.Background(), "P", nil); err == nil {
				t.Error("expected an error")
			}
		})
	}
}

// The prompt caps the song list so a huge playlist cannot blow up the context
// window; songs past the cap must simply not appear.
func TestPlaylistDescUserPrompt_capsSongList(t *testing.T) {
	songs := make([]library.PlaylistTrackBrief, 60)
	for i := range songs {
		songs[i] = library.PlaylistTrackBrief{Title: "Track", Artist: "A", Genres: []string{"rock"}}
	}
	songs[45].Title = "PastTheCap"

	chat := &cannedChat{reply: `{"punchy":"a","evocative":"b","factual":"c"}`}
	if _, err := NewDescriptionWriter(chat).PlaylistDescriptions(context.Background(), "Big", songs); err != nil {
		t.Fatalf("PlaylistDescriptions: %v", err)
	}
	if got := strings.Count(chat.lastUser, "- Track"); got != 40 {
		t.Errorf("prompt listed %d songs, want the 40-song cap", got)
	}
	if strings.Contains(chat.lastUser, "PastTheCap") {
		t.Error("a song past the 40-song cap leaked into the prompt")
	}
}
