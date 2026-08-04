package studio

import (
	"context"
	"strings"
	"testing"

	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/llm"
)

// effortChat records the reasoning effort each flow asked for. It answers with
// reply, or — when replies is set — with the next canned reply, so a multi-turn
// flow can be driven and EVERY turn's effort recorded.
type effortChat struct {
	reply   string
	replies []string
	effort  string
	efforts []string
	calls   int
}

func (e *effortChat) Chat(ctx context.Context, _ []llm.Message, _ []llm.Tool) (llm.Message, error) {
	e.effort = llm.ReasoningEffortFrom(ctx)
	e.efforts = append(e.efforts, e.effort)
	reply := e.reply
	if len(e.replies) > 0 {
		reply = ""
		if e.calls < len(e.replies) {
			reply = e.replies[e.calls]
		}
	}
	e.calls++
	return llm.Message{Role: "assistant", Content: reply}, nil
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

	// The flows that most need to stay deep: the research run and the lyrics
	// rewrite. Nothing in them opts in today, and this pins that — a stray
	// WithReasoningEffort further up would otherwise reach them silently.
	t.Run("generating a run", func(t *testing.T) {
		chat := &effortChat{replies: threeTurnReplies()}
		if _, err := New(chat, &fakeTools{}).Generate(context.Background(),
			GenerateRequest{Reference: "Metallica, Enter Sandman"}, nil, nil); err != nil {
			t.Fatal(err)
		}
		if len(chat.efforts) != 3 {
			t.Fatalf("efforts = %q, want one per turn", chat.efforts)
		}
		for i, e := range chat.efforts {
			if e != "" {
				t.Fatalf("turn %d effort = %q, want the client's own setting", i+1, e)
			}
		}
	})

	t.Run("refining the lyrics", func(t *testing.T) {
		chat := &effortChat{reply: `{"lyrics":"[Verse]\nfresh words"}`}
		if _, err := New(chat, &fakeTools{}).Refine(context.Background(),
			RefineRequest{Reference: "x", Lyrics: "[Verse]\nold words", Instruction: "darker"}, nil); err != nil {
			t.Fatal(err)
		}
		if chat.effort != "" {
			t.Fatalf("effort = %q, want the client's own setting", chat.effort)
		}
	})
}

// The reference song is the only part of turn 1 that varies between runs, so it
// goes last: everything ahead of it is a prefix the upstream can serve from
// cache. A change that puts it back in front shortens that prefix by the ~900
// tokens of turn-1 rules on every run — see generateUserPrompt.
func TestGenerateUserPrompt_putsTheVaryingReferenceLast(t *testing.T) {
	got := generateUserPrompt("Metallica — Enter Sandman")
	if !strings.HasPrefix(got, generateTurn1Prompt) {
		t.Fatalf("turn-1 instructions must lead the message, got: %.80q", got)
	}
	if !strings.HasSuffix(got, "Reference song: Metallica — Enter Sandman") {
		t.Fatalf("the reference must trail the message, got: %q", got[len(got)-80:])
	}
}
