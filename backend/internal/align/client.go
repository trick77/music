// Package align is the Go client for the word-timing alignment sidecar. It sends a
// song's audio + known lyrics and returns per-word timings. All ML lives in the
// sidecar; this package only speaks its HTTP contract.
package align

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// Word is one aligned word: start/end seconds from track start, plus a 0..1 confidence.
type Word struct {
	W     string  `json:"w"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Conf  float64 `json:"conf"`
}

// Line groups the words of one original lyric line with its overall span.
type Line struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Words []Word  `json:"words"`
}

// Result is the sidecar's full response for one song.
type Result struct {
	Engine   string `json:"engine"`
	Language string `json:"language"` // language the sidecar aligned with (detected from lyrics)
	Lines    []Line `json:"lines"`
}

// Client calls the alignment sidecar synchronously.
type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a client for a sidecar base URL (e.g. "http://align:8000") with a
// per-request timeout covering the whole (minutes-long) alignment.
func New(baseURL string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{Timeout: timeout}}
}

// Align POSTs the audio + lyrics as multipart/form-data and returns parsed timings.
// A non-2xx response surfaces the sidecar's {"error":...} reason.
func (c *Client) Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*Result, error) {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		var err error
		defer func() { _ = pw.CloseWithError(err) }()
		if err = mw.WriteField("lyrics", lyrics); err != nil {
			return
		}
		var fw io.Writer
		if fw, err = mw.CreateFormFile("audio", filename); err != nil {
			return
		}
		if _, err = io.Copy(fw, audio); err != nil {
			return
		}
		err = mw.Close()
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/align", pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Error != "" {
			return nil, fmt.Errorf("align sidecar: %s", e.Error)
		}
		return nil, fmt.Errorf("align sidecar: status %d", resp.StatusCode)
	}
	var out Result
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("align sidecar: bad JSON: %w", err)
	}
	return &out, nil
}
