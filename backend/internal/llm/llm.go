// Package llm is a minimal OpenAI-compatible chat client with tool-calling,
// used by the Studio feature to drive MiMo 2.5 Pro through a web-research loop.
// It is a trimmed, non-streaming port of the client in ../loom.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultModel           = "mimo-v2.5-pro"
	defaultReasoningEffort = "high"
	defaultTimeout         = 2 * time.Minute
	maxErrorBodyBytes      = 4096
)

// Message is one OpenAI-compatible chat message. A role:"tool" message carries a
// ToolCallID linking it to the assistant tool call it answers.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// Tool is an OpenAI function-calling tool definition advertised to the model.
type Tool struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ToolCallFunction `json:"function"`
}

type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Chat is the minimal interface the research loop depends on. The real
// implementation is *Client; tests inject a fake.
type Chat interface {
	Chat(ctx context.Context, messages []Message, tools []Tool) (Message, error)
}

// Client talks to an OpenAI-compatible /chat/completions endpoint (MiMo).
type Client struct {
	BaseURL         string
	APIKey          string
	Model           string // defaults to mimo-v2.5-pro
	ReasoningEffort string // defaults to high
	HTTP            *http.Client
}

type chatRequest struct {
	Model           string    `json:"model"`
	Messages        []Message `json:"messages"`
	Stream          bool      `json:"stream"`
	Tools           []Tool    `json:"tools,omitempty"`
	ReasoningEffort string    `json:"reasoning_effort,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content   string     `json:"content"`
			ToolCalls []ToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage tokenUsage `json:"usage"`
}

// Chat issues a single non-streaming completion and returns the assistant
// message (content and/or tool calls). Every call is observed: a completed
// inference logs its model, duration, finish reason and token usage; a failed
// one logs the model, duration and error (mirrors ../loom's llm logging).
func (c *Client) Chat(ctx context.Context, messages []Message, tools []Tool) (Message, error) {
	model := c.Model
	if model == "" {
		model = defaultModel
	}
	start := time.Now()
	msg, finishReason, usage, err := c.chat(ctx, model, messages, tools)
	dur := time.Since(start)
	if err != nil {
		logInferenceFailed(ctx, model, dur, err)
		return Message{}, err
	}
	logInferenceCompleted(ctx, model, dur, finishReason, usage)
	return msg, nil
}

func (c *Client) chat(ctx context.Context, model string, messages []Message, tools []Tool) (Message, string, tokenUsage, error) {
	effort := c.ReasoningEffort
	if effort == "" {
		effort = defaultReasoningEffort
	}
	body, err := json.Marshal(chatRequest{
		Model: model, Messages: messages, Stream: false, Tools: tools, ReasoningEffort: effort,
	})
	if err != nil {
		return Message{}, "", tokenUsage{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(c.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, "", tokenUsage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return Message{}, "", tokenUsage{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
		return Message{}, "", tokenUsage{}, fmt.Errorf("chat completion failed with status %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	var parsed chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return Message{}, "", tokenUsage{}, err
	}
	if len(parsed.Choices) == 0 {
		return Message{}, "", tokenUsage{}, fmt.Errorf("chat completion returned no choices")
	}
	choice := parsed.Choices[0].Message
	return Message{Role: "assistant", Content: choice.Content, ToolCalls: choice.ToolCalls},
		parsed.Choices[0].FinishReason, parsed.Usage, nil
}
