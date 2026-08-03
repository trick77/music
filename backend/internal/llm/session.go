package llm

import (
	"context"
	"crypto/rand"
	"fmt"
	"sync/atomic"
	"time"
)

// chatUserAgent is the User-Agent sent to the MiMo endpoint. Go's default
// "Go-http-client/1.1" identifies the caller as a bot; the upstream is happier
// with the client string an ordinary OpenAI-compatible SDK sends. Ported from
// ../loom's llm client along with the session headers below.
const chatUserAgent = "opencode/1.18.11 ai-sdk/openai-compatible/3.0.20 ai-sdk/provider-utils/5.0.18 runtime/bun/1.3.14"

// Session ids mirror the shape the upstream issues, e.g.
//
//	ses_ 0367809bfffe ejtHKm95o6rU4mQ
//	│    └─12 hex────┘ └─14 base62───┘
//	│    timestamp+counter   random
//	prefix
//
// The 12 hex digits are the bitwise inversion of (millis << 12 | counter),
// truncated to 48 bits and written big-endian — a 12-bit per-process counter
// keeps ids minted in the same millisecond distinct, and the inversion is what
// gives upstream ids their characteristic trailing f's.
const (
	sessionIDPrefix   = "ses_"
	sessionIDRandomLn = 14
	sessionIDAlphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

var sessionCounter atomic.Uint64

// processSessionID is the fallback affinity id for calls made outside a
// WithSession scope (the one-shot description and genre-prompt helpers). It is
// minted once per backend process, so those calls still pin to a single upstream
// node for the process lifetime.
var processSessionID = newSessionID()

type sessionIDKey struct{}

// WithSession starts a new affinity scope: every chat call made with the
// returned context sends the same session id, so a multi-turn Studio run pins to
// one upstream node instead of scattering its turns across the fleet. Callers
// set it once at the top of a run — Generate's research loop and its follow-up
// turns are one conversation and share the ctx.
func WithSession(ctx context.Context) context.Context {
	return context.WithValue(ctx, sessionIDKey{}, newSessionID())
}

// sessionIDFrom returns the affinity id for a call: the one WithSession put on
// the context, else the per-process fallback.
func sessionIDFrom(ctx context.Context) string {
	if id, ok := ctx.Value(sessionIDKey{}).(string); ok && id != "" {
		return id
	}
	return processSessionID
}

// newSessionID mints "ses_" + 12 hex (timestamp+counter) + 14 base62 random.
func newSessionID() string {
	millis := uint64(time.Now().UnixMilli())
	counter := sessionCounter.Add(1) & 0xFFF // 12 bits
	stamp := ^(millis<<12 | counter) & 0xFFFFFFFFFFFF
	return fmt.Sprintf("%s%012x%s", sessionIDPrefix, stamp, randomBase62(sessionIDRandomLn))
}

// randomBase62 draws n characters from the base62 alphabet. Rejection sampling
// keeps the draw unbiased; if the system entropy source fails the id degrades to
// the alphabet's first character rather than failing a model call, since this is
// an opaque routing token and not a secret.
func randomBase62(n int) string {
	const limit = 256 - (256 % len(sessionIDAlphabet)) // largest unbiased byte range
	out := make([]byte, 0, n)
	buf := make([]byte, n)
	for len(out) < n {
		if _, err := rand.Read(buf); err != nil {
			for len(out) < n {
				out = append(out, sessionIDAlphabet[0])
			}
			break
		}
		for _, b := range buf {
			if int(b) >= limit {
				continue
			}
			out = append(out, sessionIDAlphabet[int(b)%len(sessionIDAlphabet)])
			if len(out) == n {
				break
			}
		}
	}
	return string(out)
}
