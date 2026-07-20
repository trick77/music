package httpapi

import (
	"errors"
	"regexp"
)

// queryStringRe matches a URL query string ("?" plus everything up to the
// next whitespace or quote/bracket character that would otherwise close the
// URL literal in a wrapped error message). Group 1 keeps the leading "?".
var queryStringRe = regexp.MustCompile(`(\?)[^\s"'<>]*`)

// userinfoRe matches "user:password@" credentials embedded in a URL
// ("scheme://user:pass@host/...").
var userinfoRe = regexp.MustCompile(`://[^\s/@"']+:[^\s/@"']+@`)

// redactErr scrubs URL query strings and userinfo credentials out of an
// error's rendered message, for safe use as a structured log attribute.
//
// The obvious implementation — errors.As to find an inner *url.Error and
// mutate its URL field in place — is broken whenever the error has been
// wrapped with fmt.Errorf's %w: %w renders and freezes the message at wrap
// time, so mutating the inner struct afterward cannot change what the
// wrapper's Error() returns. auth.Authenticator.Exchange always wraps this
// way, so redactErr instead scrubs the already-rendered message text, which
// is immune to wrapping depth.
//
// When nothing needed redacting, the original err is returned unchanged. When
// redaction did occur, the result is a fresh errors.New of the scrubbed text,
// which deliberately breaks errors.Is/errors.As on the returned value. That is
// acceptable only because this helper's output is used solely as a log
// attribute, never for control flow.
func redactErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	scrubbed := userinfoRe.ReplaceAllString(msg, "://[redacted]@")
	scrubbed = queryStringRe.ReplaceAllString(scrubbed, "$1[redacted]")
	if scrubbed == msg {
		return err
	}
	return errors.New(scrubbed)
}
