package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/llm"
)

// cannedChat returns one fixed reply regardless of input, and records the last
// system + user prompts so tests can assert prompt content.
type cannedChat struct {
	reply      string
	lastSystem string
	lastUser   string
}

func (c *cannedChat) Chat(_ context.Context, messages []llm.Message, _ []llm.Tool) (llm.Message, error) {
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
		`{"stylePrompt":"1990s,heavy metal,thrash","lyrics":"[Verse]\nfresh words","coverArtPrompt":"a dim bedroom, 1991 thrash aesthetic"}` +
		"\n```\nHope that helps!"}
	p := New(chat, &fakeTools{})

	res, err := p.Generate(context.Background(), GenerateRequest{Reference: "Metallica, Enter Sandman"}, nil)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if res.StylePrompt != "1990s,heavy metal,thrash" {
		t.Fatalf("StylePrompt = %q", res.StylePrompt)
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

func TestGenerate_errorsOnUnparseableReply(t *testing.T) {
	p := New(&cannedChat{reply: "I could not find that song."}, &fakeTools{})
	if _, err := p.Generate(context.Background(), GenerateRequest{Reference: "x"}, nil); err == nil {
		t.Fatal("expected error when reply has no JSON object")
	}
}

func TestRefine_returnsUpdatedLyricsAndPassesInstruction(t *testing.T) {
	chat := &cannedChat{reply: `{"lyrics":"[Verse]\nno forbidden word here"}`}
	p := New(chat, &fakeTools{})

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
