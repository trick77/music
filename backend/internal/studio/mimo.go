package studio

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trick77/music/internal/llm"
)

// mimoProvider is the real Provider: it drives an LLM research loop and parses
// the model's JSON answer.
type mimoProvider struct {
	chat  llm.Chat
	tools toolProvider
}

// New builds a Provider from a chat model and a research tool provider.
func New(chat llm.Chat, tools toolProvider) Provider {
	return &mimoProvider{chat: chat, tools: tools}
}

func (p *mimoProvider) Generate(ctx context.Context, req GenerateRequest, onProgress ProgressFunc) (GenerateResult, error) {
	raw, err := runResearch(ctx, p.chat, p.tools, generateSystemPrompt, generateUserPrompt(req.Reference), onProgress)
	if err != nil {
		return GenerateResult{}, err
	}
	obj, err := extractJSONObject(raw)
	if err != nil {
		return GenerateResult{}, err
	}
	var res GenerateResult
	if err := json.Unmarshal([]byte(obj), &res); err != nil {
		return GenerateResult{}, fmt.Errorf("studio: could not parse generate result: %w", err)
	}
	if res.StylePrompt == "" || res.Lyrics == "" || res.CoverArtPrompt == "" {
		return GenerateResult{}, fmt.Errorf("studio: generate result missing a field")
	}
	return res, nil
}

func (p *mimoProvider) Refine(ctx context.Context, req RefineRequest, onProgress ProgressFunc) (string, error) {
	raw, err := runResearch(ctx, p.chat, p.tools, refineSystemPrompt,
		refineUserPrompt(req.Reference, req.Lyrics, req.Instruction), onProgress)
	if err != nil {
		return "", err
	}
	obj, err := extractJSONObject(raw)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Lyrics string `json:"lyrics"`
	}
	if err := json.Unmarshal([]byte(obj), &parsed); err != nil {
		return "", fmt.Errorf("studio: could not parse refine result: %w", err)
	}
	if parsed.Lyrics == "" {
		return "", fmt.Errorf("studio: refine result missing lyrics")
	}
	return parsed.Lyrics, nil
}

// extractJSONObject returns the outermost {...} object from a model reply,
// tolerating surrounding prose or code fences.
func extractJSONObject(s string) (string, error) {
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start < 0 || end <= start {
		return "", fmt.Errorf("studio: no JSON object in model reply")
	}
	return s[start : end+1], nil
}
