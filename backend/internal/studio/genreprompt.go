package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trick77/music/internal/llm"
)

// GenrePrompter authors a genre-background image prompt from a genre name via a
// single LLM completion — no web research, no tools. It is the bridge between a
// genre and the BFL image pipeline: the returned prompt seeds the editable box
// in the genre editor, where the user tweaks it and hits Generate.
type GenrePrompter interface {
	GenrePrompt(ctx context.Context, genre string) (string, error)
}

type genrePrompter struct {
	chat llm.Chat
}

// NewGenrePrompter builds a GenrePrompter over a chat model.
func NewGenrePrompter(chat llm.Chat) GenrePrompter { return &genrePrompter{chat: chat} }

func (p *genrePrompter) GenrePrompt(ctx context.Context, genre string) (string, error) {
	msgs := []llm.Message{
		{Role: "system", Content: genrePromptSystemPrompt},
		{Role: "user", Content: genrePromptUserPrompt(genre)},
	}
	reply, err := p.chat.Chat(ctx, msgs, nil) // no tools: one-shot completion
	if err != nil {
		return "", err
	}
	obj, err := extractJSONObject(reply.Content)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal([]byte(obj), &parsed); err != nil {
		return "", fmt.Errorf("studio: could not parse genre prompt: %w", err)
	}
	prompt := strings.TrimSpace(parsed.Prompt)
	if prompt == "" {
		return "", fmt.Errorf("studio: genre prompt is empty")
	}
	return prompt, nil
}
