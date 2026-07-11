// Command mockoidc runs the in-process mock OpenID Connect provider as a
// standalone server for local/Playwright validation of the oidc auth flow. It
// is a development tool only — never deploy it.
//
// Usage:
//
//	MOCKOIDC_ADDR=:9000 MOCKOIDC_ISSUER=http://localhost:9000 \
//	MOCKOIDC_USERNAME=alice MOCKOIDC_GROUPS=music-users go run ./cmd/mockoidc
package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/trick77/music/internal/mockoidc"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	addr := env("MOCKOIDC_ADDR", ":9000")
	issuer := env("MOCKOIDC_ISSUER", "http://localhost:9000")

	srv := mockoidc.New(issuer)
	srv.Username = env("MOCKOIDC_USERNAME", "alice")
	if g := os.Getenv("MOCKOIDC_GROUPS"); g != "" {
		srv.Groups = strings.Split(g, ",")
	}

	slog.Info("mockoidc listening", "issuer", issuer, "addr", addr, "user", srv.Username, "groups", srv.Groups)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		slog.Error("mockoidc failed", "err", err)
		os.Exit(1)
	}
}
