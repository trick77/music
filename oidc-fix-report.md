# OIDC callback swallowed-error fix — report

## What was implemented

1. **`backend/internal/httpapi/log.go`** — new file, home for the `redactErr`
   helper (plus its two supporting compiled regexes, `queryStringRe` and
   `userinfoRe`).

   `redactErr` operates on the *rendered* `err.Error()` string, not by
   `errors.As`-ing to an inner `*url.Error` and mutating its `.URL` field.
   The doc comment explicitly calls out why: `fmt.Errorf("...: %w", err)`
   renders and freezes the message at wrap time, so mutating the inner
   struct afterward can't change what the wrapper's `Error()` returns —
   which is exactly the shape `auth.Authenticator.Exchange` produces
   (`fmt.Errorf("code exchange: %w", err)`, etc.).

   Behavior:
   - Strips whole query strings (`?...` up to whitespace/quote/bracket),
     keeping the `?` as a marker.
   - Strips `user:pass@` userinfo, keeping `://` and the host.
   - Returns the **original** `err` unchanged when nothing was redacted
     (verified by pointer identity in a test).
   - Returns a fresh `errors.New(scrubbed)` when redaction did occur. Doc
     comment states this deliberately breaks `errors.Is`/`errors.As` on the
     result, acceptable only because the output is used solely as a log
     attribute, never for control flow.

2. **`backend/internal/httpapi/authhandlers.go`** — in `callback`, the
   `Exchange` failure branch now logs before responding:

   ```go
   claims, err := h.authr.Exchange(r.Context(), code, nonceCookie.Value)
   if err != nil {
       // Warn, not Error: a user abandoning the consent screen or a
       // replayed/expired code also lands here, so this isn't necessarily a
       // server-side fault. redactErr keeps a misconfigured-provider secret
       // (client_secret in a wrapped *url.Error) out of the log.
       slog.Warn("oidc: exchange failed", "err", redactErr(err))
       httpError(w, http.StatusUnauthorized, "authentication failed")
       return
   }
   ```

   Added `log/slog` to the import block. Nothing else in the handler
   changed: the three 400 bail-outs (invalid state / missing code / missing
   nonce) are untouched, per the task's explicit instruction — they're
   genuine client errors with no error value to log.

3. **Tests**
   - `backend/internal/httpapi/log_test.go` — unit tests for `redactErr`:
     - `TestRedactErr_stripsQueryStringThroughWrap` — the key regression
       test: wraps a `*url.Error` carrying `client_secret=SUPERSECRET` and
       `code=abc123` in its `.URL` with `fmt.Errorf("code exchange: %w", ...)`,
       then asserts the secret and code are gone from `redactErr(wrapped).Error()`
       while the host (`provider.example`) and path (`/token`) remain.
     - `TestRedactErr_stripsUserinfo` — `user:pass@host` credentials scrubbed,
       host/path kept.
     - `TestRedactErr_plainAndNilUnchanged` — `nil` in, `nil` out; a plain
       error with nothing to redact comes back as the exact same pointer.
   - `backend/internal/httpapi/authhandlers_log_test.go` —
     `TestCallback_exchangeFailureIsLoggedWithoutLeakingCode`: drives a real
     `Exchange` failure through the full callback handler (an authorization
     code the mock OIDC provider never issued, so its token endpoint 400s),
     using the existing `mockoidc`/`newOIDCEnv` test seam from
     `authflow_test.go`. It swaps `slog.Default()` for a buffer-backed
     `slog.NewTextHandler` (restored via `t.Cleanup`) and asserts, in one
     test, all of:
     - response status is still exactly 401
     - response body is still exactly `{"error":"authentication failed"}\n`
       (byte-for-byte, unchanged from before this fix)
     - the log buffer *does* contain `"oidc"` + `"exchange"` and
       `level=WARN` — i.e., logging positively happened (this is the trap:
       a test that only checks the secret's absence passes trivially if
       logging is broken/missing)
     - the log buffer does *not* contain the bogus auth code

   This path was deliberately **not** built against one of the 400 bail-outs
   (invalid state / missing code / missing nonce) — those never reach
   `Exchange` or `redactErr`, so a leak test there would pass even with
   `redactErr` deleted entirely.

## TDD evidence

**RED** — before `redactErr` existed:

```
$ go test ./internal/httpapi/... -run 'TestRedactErr|TestCallback_exchangeFailure' -v
# github.com/trick77/music/internal/httpapi [github.com/trick77/music/internal/httpapi.test]
internal/httpapi/log_test.go:24:9: undefined: redactErr
internal/httpapi/log_test.go:46:9: undefined: redactErr
internal/httpapi/log_test.go:63:12: undefined: redactErr
internal/httpapi/log_test.go:67:9: undefined: redactErr
FAIL	github.com/trick77/music/internal/httpapi [build failed]
FAIL
```

Expected: fails because `redactErr` doesn't exist yet (compile error), not
because of some unrelated issue — confirms the tests actually exercise the
not-yet-written code.

**GREEN** — after implementing `log.go` and wiring the callback:

```
$ go test ./internal/httpapi/... -run 'TestRedactErr|TestCallback_exchangeFailure|TestOIDCFlow' -v
=== RUN   TestOIDCFlow_memberGetsSession
--- PASS: TestOIDCFlow_memberGetsSession (0.06s)
=== RUN   TestOIDCFlow_nonMemberIsReadOnly
--- PASS: TestOIDCFlow_nonMemberIsReadOnly (0.08s)
=== RUN   TestOIDCFlow_unsetGroupGrantsAnyLogin
--- PASS: TestOIDCFlow_unsetGroupGrantsAnyLogin (0.07s)
=== RUN   TestOIDCFlow_stateMismatchRejected
--- PASS: TestOIDCFlow_stateMismatchRejected (0.10s)
=== RUN   TestOIDCFlow_missingStateCookieRejected
--- PASS: TestOIDCFlow_missingStateCookieRejected (0.05s)
=== RUN   TestOIDCFlow_missingCodeRejected
--- PASS: TestOIDCFlow_missingCodeRejected (0.07s)
=== RUN   TestOIDCFlow_logoutClearsSession
--- PASS: TestOIDCFlow_logoutClearsSession (0.07s)
=== RUN   TestCallback_exchangeFailureIsLoggedWithoutLeakingCode
--- PASS: TestCallback_exchangeFailureIsLoggedWithoutLeakingCode (0.03s)
=== RUN   TestRedactErr_stripsQueryStringThroughWrap
--- PASS: TestRedactErr_stripsQueryStringThroughWrap (0.00s)
=== RUN   TestRedactErr_stripsUserinfo
--- PASS: TestRedactErr_stripsUserinfo (0.00s)
=== RUN   TestRedactErr_plainAndNilUnchanged
--- PASS: TestRedactErr_plainAndNilUnchanged (0.00s)
PASS
ok  	github.com/trick77/music/internal/httpapi	0.991s
```

All pre-existing `TestOIDCFlow_*` tests still pass unchanged, confirming the
401 status/body and the untouched 400 paths.

## Explicit evidence: leak test fails against a mutate-in-place implementation

Per the task's warning, I temporarily replaced `log.go`'s `redactErr` with
the "obvious but broken" implementation (find `*url.Error` via `errors.As`,
mutate `.URL`/`.User` in place, return the original `err`):

```go
func redactErr(err error) error {
	if err == nil {
		return nil
	}
	var uerr *url.Error
	if errors.As(err, &uerr) {
		if u, perr := url.Parse(uerr.URL); perr == nil {
			u.RawQuery = ""
			u.User = nil
			uerr.URL = u.String()
		}
	}
	return err
}
```

Result:

```
$ go test ./internal/httpapi/... -run 'TestRedactErr_stripsQueryStringThroughWrap' -v
=== RUN   TestRedactErr_stripsQueryStringThroughWrap
    log_test.go:30: secret leaked through wrap: code exchange: Post "https://provider.example/token?client_secret=SUPERSECRET&code=abc123": dial tcp: connection refused
--- FAIL: TestRedactErr_stripsQueryStringThroughWrap (0.00s)
FAIL
FAIL	github.com/trick77/music/internal/httpapi	0.462s
```

This confirms the test genuinely catches the mutate-in-place bug — it isn't
vacuous. The broken code was then removed and the real `log.go` restored
(verified byte-identical to what was committed; full suite re-run green
afterward, see below).

## Full verification after restoring the real implementation

```
$ go build ./...            # clean
$ go test ./...             # all packages ok, including internal/httpapi
$ go vet ./...              # clean, no output
$ gofmt -l internal/httpapi/log.go internal/httpapi/log_test.go \
    internal/httpapi/authhandlers_log_test.go internal/httpapi/authhandlers.go
                             # no output — all touched files already formatted
```

`go test ./...` full output (all green):

```
?   	github.com/trick77/music/cmd/mockoidc	[no test files]
?   	github.com/trick77/music/cmd/music	[no test files]
ok  	github.com/trick77/music/internal/align	0.374s
ok  	github.com/trick77/music/internal/auth	(cached)
ok  	github.com/trick77/music/internal/config	0.681s
ok  	github.com/trick77/music/internal/httpapi	4.582s
ok  	github.com/trick77/music/internal/imagegen	0.820s
ok  	github.com/trick77/music/internal/imagescale	3.204s
ok  	github.com/trick77/music/internal/imageutil	1.127s
ok  	github.com/trick77/music/internal/library	2.830s
ok  	github.com/trick77/music/internal/llm	3.180s
ok  	github.com/trick77/music/internal/mcp	2.522s
ok  	github.com/trick77/music/internal/media	3.482s
ok  	github.com/trick77/music/internal/metadata	2.852s
?   	github.com/trick77/music/internal/mockoidc	[no test files]
ok  	github.com/trick77/music/internal/sharecard	3.717s
ok  	github.com/trick77/music/internal/store	3.776s
ok  	github.com/trick77/music/internal/studio	3.673s
ok  	github.com/trick77/music/web	3.694s
```

## Files changed

- `backend/internal/httpapi/log.go` (new) — `redactErr`, `queryStringRe`, `userinfoRe`
- `backend/internal/httpapi/authhandlers.go` — import `log/slog`; log the
  redacted `Exchange` error at Warn before returning the 401
- `backend/internal/httpapi/log_test.go` (new) — `redactErr` unit tests
- `backend/internal/httpapi/authhandlers_log_test.go` (new) — callback
  integration test for the logging + non-leak behavior

Commit: `2bf8ddd` — `fix(auth): log the OIDC exchange failure instead of swallowing it`

## Self-review / concerns

- Scope discipline held: `serverError`/`httpError` untouched, the three 400
  bail-outs untouched, no request-logging middleware added, no unrelated
  refactor.
- `redactErr`'s regexes are intentionally simple (no full URL parsing) since
  the input is an arbitrary error message, not a guaranteed well-formed URL;
  they're anchored on `?` and `://user:pass@` markers, which is what
  `*url.Error.Error()` and similar wrapped errors actually produce. I did not
  find a case in the existing codebase where this over- or under-matches,
  but it's a heuristic, not a parser — worth knowing if new error shapes are
  wrapped through this path later.
- No other files needed touching; `gofmt -l` was only run against files I
  touched, per the task's instruction (no repo-wide formatting drift was
  introduced or investigated beyond that).
- No blockers encountered; nothing required clarification beyond what the
  task spec already resolved.

## Post-review follow-up (commit on top of `2bf8ddd`)

Review came back "Ready for PR" on the production code (`redactErr` and the
`%w`-wrap unit test are sound and load-bearing), with two test/comment fixes
requested before opening the PR:

1. **`TestCallback_exchangeFailureIsLoggedWithoutLeakingCode` was vacuous on
   its leak assertion.** The reviewer traced it correctly: `mockoidc.token()`
   (`internal/mockoidc/mockoidc.go:149-152`) responds with a plain
   `http.Error(w, "invalid code", 400)` that never echoes the submitted code,
   `oauth2.RetrieveError.Error()` renders only status+body (never the request
   URL), and `client_secret`/`code` travel in the POST body, never the URL. So
   `bogusCode` could never have appeared in that error whether or not
   `redactErr` was called — the leak assertion would pass identically with
   `redactErr` deleted from the call site. Fixed by renaming the test to
   `TestCallback_exchangeFailureIsLogged`, dropping the leak assertion, adding
   a positive `err=` attribute check, and rewriting the docstring to state
   plainly what this test does and does not prove — redaction is covered by
   `log_test.go`'s unit tests; this test covers only that the handler wires
   `Exchange`'s error into `slog.Warn`.

2. **Inaccurate threat-model comment.** `authhandlers.go`'s comment claimed
   redaction guards against "a misconfigured-provider secret (client_secret
   in a wrapped *url.Error)" — but per point 1, `x/oauth2` never puts
   `client_secret` in the token-endpoint URL. Reworded to describe redaction
   as defence in depth against some future URL-bearing error (a different
   provider client, or a proxied `http.Client`) carrying credentials in its
   query string or userinfo, without claiming `x/oauth2` does this today.

No production behavior changed — both fixes are test/comment only.

### Verification after the follow-up

```
$ go test ./internal/httpapi/ -run "TestCallback|TestRedactErr" -v
=== RUN   TestCallback_exchangeFailureIsLogged
--- PASS: TestCallback_exchangeFailureIsLogged (0.11s)
=== RUN   TestRedactErr_stripsQueryStringThroughWrap
--- PASS: TestRedactErr_stripsQueryStringThroughWrap (0.00s)
=== RUN   TestRedactErr_stripsUserinfo
--- PASS: TestRedactErr_stripsUserinfo (0.00s)
=== RUN   TestRedactErr_plainAndNilUnchanged
--- PASS: TestRedactErr_plainAndNilUnchanged (0.00s)
PASS
ok  	github.com/trick77/music/internal/httpapi	0.565s
```

```
$ go test ./...
?   	github.com/trick77/music/cmd/mockoidc	[no test files]
?   	github.com/trick77/music/cmd/music	[no test files]
ok  	github.com/trick77/music/internal/align	(cached)
ok  	github.com/trick77/music/internal/auth	(cached)
ok  	github.com/trick77/music/internal/config	(cached)
ok  	github.com/trick77/music/internal/httpapi	3.671s
ok  	github.com/trick77/music/internal/imagegen	(cached)
ok  	github.com/trick77/music/internal/imagescale	(cached)
ok  	github.com/trick77/music/internal/imageutil	(cached)
ok  	github.com/trick77/music/internal/library	(cached)
ok  	github.com/trick77/music/internal/llm	(cached)
ok  	github.com/trick77/music/internal/mcp	(cached)
ok  	github.com/trick77/music/internal/media	(cached)
ok  	github.com/trick77/music/internal/metadata	(cached)
?   	github.com/trick77/music/internal/mockoidc	[no test files]
ok  	github.com/trick77/music/internal/sharecard	(cached)
ok  	github.com/trick77/music/internal/store	(cached)
ok  	github.com/trick77/music/internal/studio	(cached)
ok  	github.com/trick77/music/web	(cached)
```

```
$ go vet ./...
(clean, no output)
$ gofmt -l internal/httpapi/log.go internal/httpapi/log_test.go internal/httpapi/authhandlers_log_test.go internal/httpapi/authhandlers.go
(clean, no output)
```
