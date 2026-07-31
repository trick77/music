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

// Generate runs the reference through three turns of ONE conversation: research
// plus the style prompt, then the lyrics, then the naming and cover art. Each
// turn's answer is sanitized and handed to onPartial straight away, so the UI
// fills a card as soon as its content exists rather than after the last turn.
// The accumulated result is still returned whole at the end.
func (p *mimoProvider) Generate(ctx context.Context, req GenerateRequest, onProgress ProgressFunc, onPartial PartialFunc) (GenerateResult, error) {
	var res GenerateResult

	raw, history, err := runResearch(ctx, p.chat, p.tools, generateSystemPrompt, generateUserPrompt(req.Reference), onProgress)
	if err != nil {
		return GenerateResult{}, err
	}
	var turn1 struct {
		StylePrompt string   `json:"stylePrompt"`
		Genres      []string `json:"genres"`
	}
	if err := decodeTurn(raw, &turn1); err != nil {
		return GenerateResult{}, err
	}
	if turn1.StylePrompt == "" {
		return GenerateResult{}, fmt.Errorf("studio: generate result missing a field")
	}
	// The style prompt has no guaranteed shape: the model sometimes leaks
	// song-structure tags or newlines into it, so normalize to the flat comma line
	// Suno's Style box expects rather than trusting the reply.
	res.StylePrompt = sanitizeStylePrompt(turn1.StylePrompt)
	// Genres, bands, titles and albums are best-effort: a prompt can't guarantee
	// the model returns at most 3 clean, unique entries, so enforce it here rather
	// than trusting the reply. Any of them missing entirely is tolerated — the
	// Identity card just shows fewer options — so they are not required fields.
	res.Genres = sanitizeList(turn1.Genres, 3)
	onPartial.emit(GenerateResult{StylePrompt: res.StylePrompt, Genres: res.Genres})

	onProgress.emit(Progress{Phase: "composing", Detail: "Writing the lyrics"})
	raw, history, err = runTurn(ctx, p.chat, history, generateTurn2Prompt)
	if err != nil {
		return GenerateResult{}, err
	}
	var turn2 struct {
		Lyrics string `json:"lyrics"`
	}
	if err := decodeTurn(raw, &turn2); err != nil {
		return GenerateResult{}, err
	}
	if turn2.Lyrics == "" {
		return GenerateResult{}, fmt.Errorf("studio: generate result missing a field")
	}
	res.Lyrics = formatLyrics(turn2.Lyrics)
	onPartial.emit(GenerateResult{Lyrics: res.Lyrics})

	onProgress.emit(Progress{Phase: "composing", Detail: "Naming the track"})
	raw, _, err = runTurn(ctx, p.chat, history, generateTurn3Prompt)
	if err != nil {
		return GenerateResult{}, err
	}
	var turn3 struct {
		CoverArtPrompt string   `json:"coverArtPrompt"`
		Titles         []string `json:"titles"`
		Albums         []string `json:"albums"`
		Bands          []string `json:"bands"`
	}
	if err := decodeTurn(raw, &turn3); err != nil {
		return GenerateResult{}, err
	}
	if turn3.CoverArtPrompt == "" {
		return GenerateResult{}, fmt.Errorf("studio: generate result missing a field")
	}
	res.CoverArtPrompt = turn3.CoverArtPrompt
	res.Titles = sanitizeList(turn3.Titles, 3)
	res.Albums = sanitizeList(turn3.Albums, 3)
	res.Bands = sanitizeList(turn3.Bands, 3)
	onPartial.emit(GenerateResult{
		CoverArtPrompt: res.CoverArtPrompt,
		Titles:         res.Titles,
		Albums:         res.Albums,
		Bands:          res.Bands,
	})
	return res, nil
}

// decodeTurn pulls the JSON object out of one turn's reply and unmarshals it into
// dst, which is that turn's own narrow shape.
func decodeTurn(raw string, dst any) error {
	obj, err := extractJSONObject(raw)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(obj), dst); err != nil {
		return fmt.Errorf("studio: could not parse generate result: %w", err)
	}
	return nil
}

// sanitizeList trims, drops blanks, de-duplicates case-insensitively, and caps
// the list at max — the ceiling the dialog shows for genres, bands, titles and
// albums.
func sanitizeList(in []string, max int) []string {
	seen := map[string]bool{}
	out := make([]string, 0, max)
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		key := strings.ToLower(s)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, s)
		if len(out) == max {
			break
		}
	}
	return out
}

// Refine rewrites only the lyrics per an instruction. Unlike Generate it does
// NOT research: the lyrics already exist, so it runs one tool-less completion
// instead of the web-research loop (which would re-run discovery from scratch).
func (p *mimoProvider) Refine(ctx context.Context, req RefineRequest, onProgress ProgressFunc) (string, error) {
	onProgress.emit(Progress{Phase: "composing", Detail: "Rewriting the lyrics"})
	msgs := []llm.Message{
		{Role: "system", Content: refineSystemPrompt},
		{Role: "user", Content: refineUserPrompt(req.Reference, req.Lyrics, req.Instruction)},
	}
	reply, err := p.chat.Chat(ctx, msgs, nil) // no tools: one-shot rewrite, no re-research
	if err != nil {
		return "", err
	}
	obj, err := extractJSONObject(reply.Content)
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
	return formatLyrics(parsed.Lyrics), nil
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
