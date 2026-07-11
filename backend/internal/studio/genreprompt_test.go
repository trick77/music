package studio

import (
	"context"
	"errors"
	"testing"

	"github.com/trick77/music/internal/llm"
)

type fakeChat struct {
	reply string
	err   error
}

func (f fakeChat) Chat(_ context.Context, _ []llm.Message, tools []llm.Tool) (llm.Message, error) {
	if len(tools) != 0 {
		return llm.Message{}, errors.New("genre prompt must be a one-shot completion with no tools")
	}
	if f.err != nil {
		return llm.Message{}, f.err
	}
	return llm.Message{Role: "assistant", Content: f.reply}, nil
}

func TestGenrePrompt_parsesJSONObject(t *testing.T) {
	p := NewGenrePrompter(fakeChat{reply: `Sure!
{"prompt":"A photorealistic thrash-metal live gig, harsh stage lights, no text."}`})
	got, err := p.GenrePrompt(context.Background(), "Thrash Metal")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "A photorealistic thrash-metal live gig, harsh stage lights, no text." {
		t.Fatalf("prompt = %q", got)
	}
}

func TestGenrePrompt_errorsOnEmpty(t *testing.T) {
	p := NewGenrePrompter(fakeChat{reply: `{"prompt":"  "}`})
	if _, err := p.GenrePrompt(context.Background(), "Jazz"); err == nil {
		t.Fatal("expected error for empty prompt")
	}
}

func TestGenrePrompt_errorsOnNoJSON(t *testing.T) {
	p := NewGenrePrompter(fakeChat{reply: `no json here`})
	if _, err := p.GenrePrompt(context.Background(), "Jazz"); err == nil {
		t.Fatal("expected error when reply has no JSON object")
	}
}
