package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/llm"
)

// cannedChat returns one fixed reply regardless of input, and records the last
// system + user prompts (and the tools it was handed) so tests can assert prompt
// content and whether the call was tool-less.
type cannedChat struct {
	reply      string
	lastSystem string
	lastUser   string
	lastTools  []llm.Tool
	calls      int
}

func (c *cannedChat) Chat(_ context.Context, messages []llm.Message, tools []llm.Tool) (llm.Message, error) {
	c.calls++
	c.lastTools = tools
	for _, m := range messages {
		if m.Role == "system" {
			c.lastSystem = m.Content
		}
		if m.Role == "user" {
			c.lastUser = m.Content
		}
	}
	return llm.Message{Role: "assistant", Content: c.reply}, nil
}

func TestGenerate_parsesThreeFieldsFromFencedJSON(t *testing.T) {
	chat := &cannedChat{reply: "Here you go:\n```json\n" +
		`{"stylePrompt":"1990s,heavy metal,thrash","lyrics":"[Verse]\nfresh words","coverArtPrompt":"a dim bedroom, 1991 thrash aesthetic","genres":["heavy metal","thrash","heavy metal","groove metal","nu metal"],"titles":["Sleep Now","Sleep Now","Grey Between Dreams","The Sandman's Ledger","Fourth Title"],"albums":["Nightfall Sessions","Hush the World","Iron Lullaby"],"bands":["Ashen Verdict","Ashen Verdict","Grey Litany","Hollow Sabbath","Fourth Band"]}` +
		"\n```\nHope that helps!"}
	p := New(chat, &fakeTools{})

	res, err := p.Generate(context.Background(), GenerateRequest{Reference: "Metallica, Enter Sandman"}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if res.StylePrompt != "1990s,heavy metal,thrash" {
		t.Fatalf("StylePrompt = %q", res.StylePrompt)
	}
	// Genres are de-duplicated (case-insensitively) and capped at 3.
	if len(res.Genres) != 3 || res.Genres[0] != "heavy metal" || res.Genres[1] != "thrash" || res.Genres[2] != "groove metal" {
		t.Fatalf("Genres = %#v, want [heavy metal, thrash, groove metal]", res.Genres)
	}
	// Titles are likewise de-duplicated and capped at 3, preserving order.
	if len(res.Titles) != 3 || res.Titles[0] != "Sleep Now" || res.Titles[1] != "Grey Between Dreams" || res.Titles[2] != "The Sandman's Ledger" {
		t.Fatalf("Titles = %#v, want [Sleep Now, Grey Between Dreams, The Sandman's Ledger]", res.Titles)
	}
	if len(res.Albums) != 3 || res.Albums[0] != "Nightfall Sessions" {
		t.Fatalf("Albums = %#v, want 3 starting with Nightfall Sessions", res.Albums)
	}
	// Bands are likewise de-duplicated and capped at 3, preserving order.
	if len(res.Bands) != 3 || res.Bands[0] != "Ashen Verdict" || res.Bands[1] != "Grey Litany" || res.Bands[2] != "Hollow Sabbath" {
		t.Fatalf("Bands = %#v, want [Ashen Verdict, Grey Litany, Hollow Sabbath]", res.Bands)
	}
	if !strings.Contains(res.Lyrics, "[Verse]") {
		t.Fatalf("Lyrics = %q", res.Lyrics)
	}
	if !strings.Contains(res.CoverArtPrompt, "1991") {
		t.Fatalf("CoverArtPrompt = %q", res.CoverArtPrompt)
	}
	// The reference must reach the model.
	if !strings.Contains(chat.lastUser, "Enter Sandman") {
		t.Fatalf("user prompt missing reference: %q", chat.lastUser)
	}
	// The system prompt must teach Suno tags.
	if !strings.Contains(chat.lastSystem, "[Verse]") {
		t.Fatalf("system prompt should mention Suno tags")
	}
}

// Bands, titles and albums are best-effort: a reply that omits them must still
// yield a usable result (the Identity card simply shows no name ideas), unlike
// the core style/lyrics/cover fields which are required.
func TestGenerate_toleratesMissingBandsTitlesAndAlbums(t *testing.T) {
	chat := &cannedChat{reply: `{"stylePrompt":"1990s,thrash","lyrics":"[Verse]\nwords","coverArtPrompt":"dim room","genres":["thrash"]}`}
	res, err := New(chat, &fakeTools{}).Generate(context.Background(), GenerateRequest{Reference: "x"}, nil)
	if err != nil {
		t.Fatalf("Generate should tolerate missing bands/titles/albums: %v", err)
	}
	if len(res.Bands) != 0 || len(res.Titles) != 0 || len(res.Albums) != 0 {
		t.Fatalf("expected empty Bands/Titles/Albums, got %#v / %#v / %#v", res.Bands, res.Titles, res.Albums)
	}
}

func TestGenerate_errorsOnUnparseableReply(t *testing.T) {
	p := New(&cannedChat{reply: "I could not find that song."}, &fakeTools{})
	if _, err := p.Generate(context.Background(), GenerateRequest{Reference: "x"}, nil); err == nil {
		t.Fatal("expected error when reply has no JSON object")
	}
}

func TestRefine_returnsUpdatedLyricsAndPassesInstruction(t *testing.T) {
	chat := &cannedChat{reply: `{"lyrics":"[Verse]\nno forbidden word here"}`}
	tools := &fakeTools{}
	p := New(chat, tools)

	lyrics, err := p.Refine(context.Background(), RefineRequest{
		Reference:   "Metallica, Enter Sandman",
		Lyrics:      "[Verse]\nold words",
		Instruction: "do not say lullaby",
	}, nil)
	if err != nil {
		t.Fatalf("Refine: %v", err)
	}
	if !strings.Contains(lyrics, "no forbidden word") {
		t.Fatalf("lyrics = %q", lyrics)
	}
	if !strings.Contains(chat.lastUser, "do not say lullaby") {
		t.Fatalf("refine instruction missing from prompt: %q", chat.lastUser)
	}
	if !strings.Contains(chat.lastUser, "old words") {
		t.Fatalf("current lyrics missing from refine prompt: %q", chat.lastUser)
	}
}

// Refine must NOT re-run the web-research/discovery loop: it should be a single
// tool-less completion, so the model is handed no tools and no tool is dispatched.
func TestRefine_doesNotResearch(t *testing.T) {
	chat := &cannedChat{reply: `{"lyrics":"[Verse]\nrewritten"}`}
	tools := &fakeTools{}
	p := New(chat, tools)

	if _, err := p.Refine(context.Background(), RefineRequest{
		Reference:   "Metallica, Enter Sandman",
		Lyrics:      "[Verse]\nold words",
		Instruction: "darker chorus",
	}, nil); err != nil {
		t.Fatalf("Refine: %v", err)
	}
	if chat.calls != 1 {
		t.Fatalf("expected exactly one completion, got %d", chat.calls)
	}
	if len(chat.lastTools) != 0 {
		t.Fatalf("refine must pass no tools, got %d", len(chat.lastTools))
	}
	if len(tools.called) != 0 {
		t.Fatalf("refine must not dispatch any tool call, got %v", tools.called)
	}
}
