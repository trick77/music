package studio

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/trick77/music/internal/library"
)

// The album-cover prompt must be grounded in the album's own lyrics — that is
// the reason lyric excerpts are passed in at all rather than just artist/album.
func TestAlbumCoverPrompt_groundsPromptInLyricsAndGenres(t *testing.T) {
	chat := &cannedChat{reply: `{"prompt":"A rain-slick harbour at dusk, square format, no text."}`}
	got, err := NewGenrePrompter(chat).AlbumCoverPrompt(context.Background(),
		"The Ninth Wave", "Harbour Lights", []string{"post-punk", "shoegaze"},
		[]library.SongLyric{
			{Title: "Signal Fire", Lyrics: "we lit the coast to bring you home"},
			{Title: "Undertow", Lyrics: "salt in the wiring"},
		})
	if err != nil {
		t.Fatalf("AlbumCoverPrompt: %v", err)
	}
	if got != "A rain-slick harbour at dusk, square format, no text." {
		t.Fatalf("prompt = %q", got)
	}
	// One-shot completion: the cover flow does no web research.
	if len(chat.lastTools) != 0 {
		t.Fatalf("album cover prompt must pass no tools, got %d", len(chat.lastTools))
	}
	for _, want := range []string{"The Ninth Wave", "Harbour Lights", "post-punk, shoegaze", "Signal Fire", "salt in the wiring"} {
		if !strings.Contains(chat.lastUser, want) {
			t.Errorf("user prompt missing %q:\n%s", want, chat.lastUser)
		}
	}
}

// With no lyrics on file the prompt must still be well-formed — it just carries
// no Lyrics block rather than an empty dangling one.
func TestAlbumCoverPrompt_withoutLyricsOmitsLyricsBlock(t *testing.T) {
	chat := &cannedChat{reply: `{"prompt":"A stark monochrome portrait, square, no text."}`}
	if _, err := NewGenrePrompter(chat).AlbumCoverPrompt(context.Background(),
		"Ash Choir", "Vigil", nil, nil); err != nil {
		t.Fatalf("AlbumCoverPrompt: %v", err)
	}
	if strings.Contains(chat.lastUser, "Lyrics:") {
		t.Errorf("no lyrics were supplied, prompt must omit the Lyrics block:\n%s", chat.lastUser)
	}
	// Genres are unknown rather than blank, so the model is not left guessing
	// whether the field was simply dropped.
	if !strings.Contains(chat.lastUser, "(unknown)") {
		t.Errorf("missing genres should read (unknown):\n%s", chat.lastUser)
	}
}

// A single whitespace-only genre is as good as absent and must read as unknown
// rather than producing a dangling "Genre(s):   " line.
//
// The multi-blank case (e.g. []string{"  ", ""}), which used to join to "  , "
// and leak through, is covered in albumprompt_test.go.
func TestAlbumCoverPrompt_blankGenreReadsAsUnknown(t *testing.T) {
	chat := &cannedChat{reply: `{"prompt":"A field of dry grass, square, no text."}`}
	if _, err := NewGenrePrompter(chat).AlbumCoverPrompt(context.Background(),
		"Ash Choir", "Vigil", []string{"  "}, nil); err != nil {
		t.Fatalf("AlbumCoverPrompt: %v", err)
	}
	if !strings.Contains(chat.lastUser, "(unknown)") {
		t.Errorf("blank genre should read (unknown):\n%s", chat.lastUser)
	}
}

// RefinePrompt must hand the model BOTH the prompt being changed and the
// instruction; losing either would silently turn a refinement into a rewrite.
func TestRefinePrompt_passesCurrentPromptInstructionAndContext(t *testing.T) {
	chat := &cannedChat{reply: `{"prompt":"A rain-slick harbour at night, no boats, no text."}`}
	got, err := NewGenrePrompter(chat).RefinePrompt(context.Background(),
		"A rain-slick harbour at dusk, no text.", "make it night and remove the boats",
		"The Ninth Wave — Harbour Lights", ShapeCover)
	if err != nil {
		t.Fatalf("RefinePrompt: %v", err)
	}
	if got != "A rain-slick harbour at night, no boats, no text." {
		t.Fatalf("prompt = %q", got)
	}
	for _, want := range []string{"A rain-slick harbour at dusk", "make it night and remove the boats", "Context: The Ninth Wave — Harbour Lights"} {
		if !strings.Contains(chat.lastUser, want) {
			t.Errorf("user prompt missing %q:\n%s", want, chat.lastUser)
		}
	}
}

// Context is optional; when absent the prompt must not carry an empty
// "Context:" header the model would try to interpret.
func TestRefinePrompt_omitsEmptyContextHeader(t *testing.T) {
	chat := &cannedChat{reply: `{"prompt":"Brighter, no text."}`}
	if _, err := NewGenrePrompter(chat).RefinePrompt(context.Background(),
		"A dim room, no text.", "brighter", "   ", ShapeCover); err != nil {
		t.Fatalf("RefinePrompt: %v", err)
	}
	if strings.Contains(chat.lastUser, "Context:") {
		t.Errorf("blank context must not emit a Context header:\n%s", chat.lastUser)
	}
	if !strings.Contains(chat.lastUser, "brighter") {
		t.Errorf("instruction missing:\n%s", chat.lastUser)
	}
}

// A cover holds one subject; a genre background holds a whole scene. The refine
// system prompt takes opposite positions on the two, so the user message must say
// which it is — otherwise the model infers it from prompt text an earlier refine
// may have muddled, and "make it warmer" strips a juke joint down to one figure.
func TestRefinePrompt_tellsTheModelWhichShapeItIsRefining(t *testing.T) {
	for name, tc := range map[string]struct {
		shape       PromptShape
		want, avoid string
	}{
		"background waives the cover rules": {ShapeBackground, "DO NOT apply", "SQUARE COVER"},
		"cover keeps them":                  {ShapeCover, "SQUARE COVER", "DO NOT apply"},
	} {
		t.Run(name, func(t *testing.T) {
			chat := &cannedChat{reply: `{"prompt":"ok"}`}
			if _, err := NewGenrePrompter(chat).RefinePrompt(
				context.Background(), "cur", "make it warmer", "", tc.shape); err != nil {
				t.Fatalf("RefinePrompt: %v", err)
			}
			if !strings.Contains(chat.lastUser, tc.want) {
				t.Errorf("user prompt missing %q:\n%s", tc.want, chat.lastUser)
			}
			if strings.Contains(chat.lastUser, tc.avoid) {
				t.Errorf("user prompt must not claim %q:\n%s", tc.avoid, chat.lastUser)
			}
			// The shape marker leads, so it is read before the prompt text.
			if !strings.HasPrefix(chat.lastUser, "This is a") {
				t.Errorf("shape marker must open the message:\n%s", chat.lastUser)
			}
		})
	}
}

// The shared {"prompt":...} contract is enforced for every one-shot flow, not
// just the genre one — an empty or unparseable reply must be an error, never an
// empty prompt handed to the image pipeline.
func TestImagePrompts_rejectEmptyAndUnparseableReplies(t *testing.T) {
	cases := map[string]string{
		"empty prompt":     `{"prompt":"   "}`,
		"no JSON object":   `I cannot do that.`,
		"wrong value type": `{"prompt":123}`,
	}
	for name, reply := range cases {
		t.Run(name, func(t *testing.T) {
			p := NewGenrePrompter(&cannedChat{reply: reply})
			if _, err := p.AlbumCoverPrompt(context.Background(), "a", "b", nil, nil); err == nil {
				t.Error("AlbumCoverPrompt: expected an error")
			}
			if _, err := p.RefinePrompt(context.Background(), "cur", "instr", "", ShapeCover); err == nil {
				t.Error("RefinePrompt: expected an error")
			}
		})
	}
}

// A transport failure must propagate rather than surface as an empty prompt.
func TestImagePrompts_propagateChatError(t *testing.T) {
	boom := errors.New("upstream unavailable")
	p := NewGenrePrompter(fakeChat{err: boom})
	if _, err := p.AlbumCoverPrompt(context.Background(), "a", "b", nil, nil); !errors.Is(err, boom) {
		t.Errorf("AlbumCoverPrompt error = %v, want %v", err, boom)
	}
	if _, err := p.RefinePrompt(context.Background(), "cur", "instr", "", ShapeCover); !errors.Is(err, boom) {
		t.Errorf("RefinePrompt error = %v, want %v", err, boom)
	}
	if _, err := p.GenrePrompt(context.Background(), "jazz"); !errors.Is(err, boom) {
		t.Errorf("GenrePrompt error = %v, want %v", err, boom)
	}
}
