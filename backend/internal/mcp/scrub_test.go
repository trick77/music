package mcp

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

// The Tavily API key rides in the URL query (see config.go), so every *url.Error
// that can reach a log line must be scrubbed. url.Parse succeeding is NOT a
// precondition for that: a URL malformed enough to break the parser is exactly
// the one whose error text echoes the raw string, key and all. These cases pin
// the fail-closed path.
func TestScrubURLError_unparseableURLStillRedacts(t *testing.T) {
	const secret = "super-secret"

	cases := []struct {
		name string
		raw  string
		// Must survive, so the error stays diagnosable.
		keep string
	}{
		{
			name: "space in host defeats url.Parse",
			raw:  "http://bad host.invalid/mcp/?tavilyApiKey=" + secret,
			keep: "bad host.invalid",
		},
		{
			name: "control character in host",
			raw:  "http://host\x7f.invalid/mcp/?tavilyApiKey=" + secret,
			keep: "/mcp/",
		},
		{
			name: "userinfo alongside an unparseable authority",
			raw:  "http://user:pass word@host.invalid/mcp/?tavilyApiKey=" + secret,
			keep: "host.invalid",
		},
		{
			name: "secret in the fragment",
			raw:  "http://bad host.invalid/mcp/#tavilyApiKey=" + secret,
			keep: "bad host.invalid",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Guard the premise: if url.Parse ever learns to accept these, this test
			// is exercising the wrong branch and should be revisited.
			if _, err := url.Parse(tc.raw); err == nil {
				t.Fatalf("premise broken: url.Parse now accepts %q", tc.raw)
			}

			in := &url.Error{Op: "Post", URL: tc.raw, Err: errors.New("dial tcp: connection refused")}
			msg := scrubURLError(in).Error()

			for _, leak := range []string{secret, "tavilyApiKey", "pass word"} {
				if strings.Contains(msg, leak) {
					t.Errorf("scrubbed error leaks %q: %s", leak, msg)
				}
			}
			if !strings.Contains(msg, tc.keep) {
				t.Errorf("scrubbing destroyed the diagnostic, want %q in: %s", tc.keep, msg)
			}
			if !strings.Contains(msg, "connection refused") {
				t.Errorf("underlying cause lost: %s", msg)
			}
		})
	}
}

// A URL with no query and no credentials has nothing to hide, so it must come
// through untouched even when url.Parse rejects it — otherwise the scrubber
// makes ordinary transport errors harder to read.
func TestScrubURLError_unparseableURLWithoutSecretsIsPreserved(t *testing.T) {
	const raw = "http://bad host.invalid/mcp/"
	in := &url.Error{Op: "Post", URL: raw, Err: errors.New("dial tcp: connection refused")}

	msg := scrubURLError(in).Error()
	if !strings.Contains(msg, raw) {
		t.Errorf("URL with nothing to redact was altered: %s", msg)
	}
	if strings.Contains(msg, redactedMarker) {
		t.Errorf("nothing to redact, yet the marker appears: %s", msg)
	}
}

// redactRawURL operates on raw text, so it carries the edge cases the structured
// url API would otherwise handle.
func TestRedactRawURL(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"query stripped", "http://h/p?k=v", "http://h/p?" + redactedMarker},
		{"fragment stripped", "http://h/p#k=v", "http://h/p?" + redactedMarker},
		{"userinfo stripped", "http://u:p@h/path", "http://" + redactedMarker + "@h/path"},
		{"both stripped", "http://u:p@h/path?k=v", "http://" + redactedMarker + "@h/path?" + redactedMarker},
		{"nothing to strip", "http://h/path", "http://h/path"},
		{"no scheme separator", "not-a-url?k=v", "not-a-url?" + redactedMarker},
		{"empty", "", ""},
		// An '@' in the path is not userinfo and must not be treated as such.
		{"at sign after the authority", "http://h/a@b", "http://h/a@b"},
		// The authority ends at the first '/', so a '?' before it still cuts first.
		{"query before any path", "http://u:p@h?k=v", "http://" + redactedMarker + "@h?" + redactedMarker},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := redactRawURL(tc.in); got != tc.want {
				t.Errorf("redactRawURL(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
