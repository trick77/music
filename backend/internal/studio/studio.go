// Package studio implements the Phase 9 Studio feature: it drives MiMo 2.5 Pro
// through a bounded web-research loop (Tavily search + fetch) to turn a named
// song into a Suno prompt — a style prompt, original theme-matched lyrics, and
// an epoch-correct cover-art prompt. Results are ephemeral; nothing is stored.
package studio

import "context"

// GenerateRequest names the song to reimagine, e.g. "Metallica, Enter Sandman".
type GenerateRequest struct {
	Reference string
}

// GenerateResult is the ephemeral output: the three Suno prompt parts, up to
// three genre labels the model picks for the song, and up to three band-name,
// song-title and album-name ideas (all shown in the Identity card in the
// dialog). Bands, titles and albums vary in directness, from an obvious pick to
// a more oblique one.
type GenerateResult struct {
	StylePrompt    string   `json:"stylePrompt"`
	Lyrics         string   `json:"lyrics"`
	CoverArtPrompt string   `json:"coverArtPrompt"`
	Genres         []string `json:"genres"`
	Bands          []string `json:"bands"`
	Titles         []string `json:"titles"`
	Albums         []string `json:"albums"`
}

// RefineRequest asks for a lyrics rewrite guided by Instruction (e.g. "do not
// say lullaby"), keeping the style and cover-art prompts fixed.
type RefineRequest struct {
	Reference   string
	Lyrics      string
	Instruction string
}

// Progress is a live status update emitted while the research loop runs, so the
// UI can show what is happening instead of a blank spinner.
type Progress struct {
	Phase  string `json:"phase"`  // researching | reading | thinking | composing
	Detail string `json:"detail"` // human-friendly one-liner
}

// ProgressFunc receives progress updates. It may be nil.
type ProgressFunc func(Progress)

func (f ProgressFunc) emit(p Progress) {
	if f != nil {
		f(p)
	}
}

// PartialFunc receives a GenerateResult that is only partly filled in, once per
// completed turn, so the UI can show each part the moment it exists instead of
// holding everything back until the last turn finishes. Fields the turn did not
// produce are zero. It may be nil.
type PartialFunc func(GenerateResult)

func (f PartialFunc) emit(r GenerateResult) {
	if f != nil {
		f(r)
	}
}

// Provider generates and refines Suno prompts. The real implementation drives an
// LLM research loop; tests inject a fake. onProgress and onPartial may be nil.
type Provider interface {
	Generate(ctx context.Context, req GenerateRequest, onProgress ProgressFunc, onPartial PartialFunc) (GenerateResult, error)
	Refine(ctx context.Context, req RefineRequest, onProgress ProgressFunc) (string, error)
}
