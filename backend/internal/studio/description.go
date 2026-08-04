package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

type PlaylistTones struct {
	Punchy    string `json:"punchy"`
	Evocative string `json:"evocative"`
	Factual   string `json:"factual"`
}

type DescriptionWriter interface {
	PlaylistDescriptions(ctx context.Context, name string, songs []library.PlaylistTrackBrief) (PlaylistTones, error)
}

type descriptionWriter struct{ chat llm.Chat }

func NewDescriptionWriter(chat llm.Chat) DescriptionWriter { return &descriptionWriter{chat: chat} }

// Low effort: three one-sentence lines with hard word caps, written from a song
// list the prompt already carries. There is nothing here to work out, and the
// request blocks a user while the model works it out anyway.
func (d *descriptionWriter) PlaylistDescriptions(ctx context.Context, name string, songs []library.PlaylistTrackBrief) (PlaylistTones, error) {
	ctx = llm.WithReasoningEffort(ctx, llm.EffortLow)
	msgs := []llm.Message{
		{Role: "system", Content: playlistDescSystemPrompt},
		{Role: "user", Content: playlistDescUserPrompt(name, songs)},
	}
	reply, err := d.chat.Chat(ctx, msgs, nil)
	if err != nil {
		return PlaylistTones{}, err
	}
	obj, err := extractJSONObject(reply.Content)
	if err != nil {
		return PlaylistTones{}, err
	}
	var t PlaylistTones
	if err := json.Unmarshal([]byte(obj), &t); err != nil {
		return PlaylistTones{}, fmt.Errorf("studio: parse playlist descriptions: %w", err)
	}
	t.Punchy, t.Evocative, t.Factual = strings.TrimSpace(t.Punchy), strings.TrimSpace(t.Evocative), strings.TrimSpace(t.Factual)
	if t.Punchy == "" || t.Evocative == "" || t.Factual == "" {
		return PlaylistTones{}, fmt.Errorf("studio: a playlist tone came back empty")
	}
	return t, nil
}
