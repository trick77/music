package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

// GenrePrompter authors editable image prompts via single LLM completions — no
// web research, no tools. It is the bridge between the library and the BFL image
// pipeline: the returned prompt seeds the editable box in a Studio panel, where
// the user tweaks it and hits Generate. Despite the name it now covers three
// one-shot flows: genre backgrounds, album covers, and prompt refinement.
type GenrePrompter interface {
	GenrePrompt(ctx context.Context, genre string) (string, error)
	// AlbumCoverPrompt authors a square album-cover prompt from artist/album/genre,
	// grounded in lyric excerpts when available.
	AlbumCoverPrompt(ctx context.Context, artist, album string, genres []string, lyrics []library.SongLyric) (string, error)
	// RefinePrompt rewrites an existing image prompt per an instruction. context is
	// optional extra grounding (e.g. the genre name or "Artist — Album").
	RefinePrompt(ctx context.Context, current, instruction, context string) (string, error)
}

type genrePrompter struct {
	chat llm.Chat
}

// NewGenrePrompter builds a GenrePrompter over a chat model.
func NewGenrePrompter(chat llm.Chat) GenrePrompter { return &genrePrompter{chat: chat} }

func (p *genrePrompter) GenrePrompt(ctx context.Context, genre string) (string, error) {
	return p.completePrompt(ctx, genrePromptSystemPrompt, genrePromptUserPrompt(genre), "genre prompt")
}

func (p *genrePrompter) AlbumCoverPrompt(ctx context.Context, artist, album string, genres []string, lyrics []library.SongLyric) (string, error) {
	return p.completePrompt(ctx, albumCoverPromptSystemPrompt, albumCoverPromptUserPrompt(artist, album, genres, lyrics), "album cover prompt")
}

func (p *genrePrompter) RefinePrompt(ctx context.Context, current, instruction, context string) (string, error) {
	return p.completePrompt(ctx, refinePromptSystemPrompt, refinePromptUserPrompt(current, instruction, context), "refined prompt")
}

// completePrompt runs one no-tool completion and parses the shared {"prompt":...}
// JSON contract. label names the flow for error messages.
func (p *genrePrompter) completePrompt(ctx context.Context, system, user, label string) (string, error) {
	msgs := []llm.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user},
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
		return "", fmt.Errorf("studio: could not parse %s: %w", label, err)
	}
	prompt := strings.TrimSpace(parsed.Prompt)
	if prompt == "" {
		return "", fmt.Errorf("studio: %s is empty", label)
	}
	return prompt, nil
}
