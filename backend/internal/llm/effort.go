package llm

import "context"

// Reasoning effort is MiMo's depth dial. It rides on the context rather than on
// Chat's signature, the same as the session id above: the Chat interface stays
// one method wide, so every fake the studio tests inject keeps compiling.
//
// The client-wide default is high, which is right for the flows that deserve it
// — the research loop, the lyrics, the cover-art brief. It is wrong for the
// short ones. A playlist description is three one-sentence lines with hard word
// caps written from a list the prompt already carries, and a prompt refinement
// is "rewrite this, keep what I didn't mention"; neither is a deduction, and
// both block a user's request while the model reasons about them anyway.
//
// The effort is a property of the FLOW, not of the client, which is why this is
// a context option and not a fourth client in server.go: the same GenrePrompter
// authors an album cover (creative, high) and refines one (mechanical, low).
const (
	EffortLow    = "low"
	EffortMedium = "medium"
	EffortHigh   = "high"
)

type effortKey struct{}

// WithReasoningEffort overrides the reasoning_effort sent for calls made with
// ctx. Absent an override the client's own setting applies, so a caller that
// never opts in is unchanged.
func WithReasoningEffort(ctx context.Context, effort string) context.Context {
	return context.WithValue(ctx, effortKey{}, effort)
}

// ReasoningEffortFrom returns the override on ctx, or "" when there is none.
// Exported so a flow's choice is assertable from the package that makes it —
// the studio tests inject a fake Chat and would otherwise see only a context.
func ReasoningEffortFrom(ctx context.Context) string {
	e, _ := ctx.Value(effortKey{}).(string)
	return e
}
