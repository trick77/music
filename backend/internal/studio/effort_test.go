package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

// effortChat records the reasoning effort each flow asked for.
type effortChat struct {
	reply  string
	effort string
}

func (e *effortChat) Chat(ctx context.Context, _ []llm.Message, _ []llm.Tool) (llm.Message, error) {
	e.effort = llm.ReasoningEffortFrom(ctx)
	return llm.Message{Role: "assistant", Content: e.reply}, nil
}

// The two mechanical flows ask for low effort; the two authoring flows ask for
// nothing and keep whatever the client is configured with. The second half is
// the guard: writing a cover from an album's lyrics is a creative act, and it
// must not drift down with its neighbours.
func TestReasoningEffort_lowOnTheMechanicalFlowsOnly(t *testing.T) {
	t.Run("refining a prompt", func(t *testing.T) {
		chat := &effortChat{reply: `{"prompt":"a quieter version"}`}
		if _, err := NewGenrePrompter(chat).RefinePrompt(context.Background(), "loud", "calmer", ""); err != nil {
			t.Fatal(err)
		}
		if chat.effort != llm.EffortLow {
			t.Fatalf("effort = %q, want low", chat.effort)
		}
	})

	t.Run("writing playlist descriptions", func(t *testing.T) {
		chat := &effortChat{reply: `{"punchy":"Go.","evocative":"Dusk on the ring road.","factual":"Twelve synth tracks."}`}
		_, err := NewDescriptionWriter(chat).PlaylistDescriptions(context.Background(), "Night drive",
			[]library.PlaylistTrackBrief{{Title: "One", Artist: "A"}})
		if err != nil {
			t.Fatal(err)
		}
		if chat.effort != llm.EffortLow {
			t.Fatalf("effort = %q, want low", chat.effort)
		}
	})

	t.Run("authoring a genre background", func(t *testing.T) {
		chat := &effortChat{reply: `{"prompt":"a hazy club"}`}
		if _, err := NewGenrePrompter(chat).GenrePrompt(context.Background(), "dream pop"); err != nil {
			t.Fatal(err)
		}
		if chat.effort != "" {
			t.Fatalf("effort = %q, want the client's own setting", chat.effort)
		}
	})

	t.Run("authoring an album cover", func(t *testing.T) {
		chat := &effortChat{reply: `{"prompt":"a cold harbour"}`}
		if _, err := NewGenrePrompter(chat).AlbumCoverPrompt(context.Background(), "A", "B", []string{"pop"}, nil); err != nil {
			t.Fatal(err)
		}
		if chat.effort != "" {
			t.Fatalf("effort = %q, want the client's own setting", chat.effort)
		}
	})
}

// The reference song is the only part of turn 1 that varies between runs, so it
// goes last: everything ahead of it is a prefix the upstream can serve from
// cache. A change that puts it back in front costs ~900 tokens of that prefix on
// every run, three times over once turns 2 and 3 replay the message.
func TestGenerateUserPrompt_putsTheVaryingReferenceLast(t *testing.T) {
	got := generateUserPrompt("Metallica — Enter Sandman")
	if !strings.HasPrefix(got, generateTurn1Prompt) {
		t.Fatalf("turn-1 instructions must lead the message, got: %.80q", got)
	}
	if !strings.HasSuffix(got, "Reference song: Metallica — Enter Sandman") {
		t.Fatalf("the reference must trail the message, got: %q", got[len(got)-80:])
	}
}
