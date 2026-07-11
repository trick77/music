package llm

import (
	"context"
	"log/slog"
	"time"
)

// tokenUsage carries the OpenAI-compatible usage block returned with a
// completion. It is optional: absent/zero when the upstream omits it.
type tokenUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func (u tokenUsage) present() bool {
	return u.PromptTokens != 0 || u.CompletionTokens != 0 || u.TotalTokens != 0
}

// logInferenceCompleted emits the structured line for a successful model call.
// A scaled-down port of ../loom's llm logging (no thread/user metadata: this
// trimmed client has no request context to carry).
func logInferenceCompleted(ctx context.Context, model string, duration time.Duration, finishReason string, usage tokenUsage) {
	attrs := []slog.Attr{
		slog.String("model", model),
		slog.Int64("duration_ms", duration.Milliseconds()),
	}
	if finishReason != "" {
		attrs = append(attrs, slog.String("finish_reason", finishReason))
	}
	if usage.present() {
		attrs = append(attrs,
			slog.Int("prompt_tokens", usage.PromptTokens),
			slog.Int("completion_tokens", usage.CompletionTokens),
			slog.Int("total_tokens", usage.TotalTokens),
		)
	}
	slog.LogAttrs(ctx, slog.LevelInfo, "llm inference completed", attrs...)
}

func logInferenceFailed(ctx context.Context, model string, duration time.Duration, err error) {
	attrs := []slog.Attr{
		slog.String("model", model),
		slog.Int64("duration_ms", duration.Milliseconds()),
		slog.String("err", err.Error()),
	}
	if cause := context.Cause(ctx); cause != nil && cause != err {
		attrs = append(attrs, slog.String("cancel_cause", cause.Error()))
	}
	slog.LogAttrs(ctx, slog.LevelError, "llm inference failed", attrs...)
}
