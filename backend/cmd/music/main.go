package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/buildinfo"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/httpapi"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
)

func main() {
	// Configure structured logging with an explicit handler so every line
	// carries an RFC3339 timestamp (the package default does not guarantee one).
	// The level is tunable via BACKEND_LOG_LEVEL (debug/info/warn/error).
	logLevel := parseLogLevel(envDefault("BACKEND_LOG_LEVEL", "info"))
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	// Directories hold database and media files and have no reason to be world-readable.
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o750); err != nil {
		return fmt.Errorf("mkdir db dir: %w", err)
	}
	if err := os.MkdirAll(cfg.MediaDir, 0o750); err != nil {
		return fmt.Errorf("mkdir media dir: %w", err)
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	defer func() { _ = st.Close() }()

	var authr *auth.Authenticator
	if cfg.AuthMode == config.AuthModeOIDC {
		authr, err = auth.NewAuthenticator(context.Background(), cfg.OIDC)
		if err != nil {
			return fmt.Errorf("oidc init: %w", err)
		}
	}

	handler := httpapi.NewWithAuth(cfg, st, web.SPAHandler(), authr)
	srv := newServer(cfg.ListenAddr, handler)

	errCh := make(chan error, 1)
	go func() {
		slog.Info("music listening", "addr", cfg.ListenAddr, "auth", string(cfg.AuthMode), "version", buildinfo.Version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			errCh <- err
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Exit non-zero on a listen failure (e.g. port in use) so the process crash-loops
	// instead of lingering with no listener; otherwise wait for a shutdown signal.
	select {
	case err := <-errCh:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	slog.Info("stopped")
	return nil
}

func envDefault(key, def string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return def
}

// parseLogLevel maps a BACKEND_LOG_LEVEL string to a slog.Level, defaulting to
// Info for empty or unrecognized values.
func parseLogLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// newServer builds the listening server. It is split out of main so the
// timeouts are assertable: a zero value means "no limit", which is what lets a
// client open a connection, stall, and hold a goroutine and a file descriptor
// indefinitely (slow loris).
//
// ReadHeaderTimeout is the one that closes slow loris, and it is the ONLY read
// deadline set here. ReadTimeout would be wrong: it bounds the whole request
// including the body, so a legal 50 MB upload (BACKEND_MAX_UPLOAD_MB) would be
// cut off on any ordinary uplink, and once the body is read the same deadline
// cancels r.Context(), which would kill the 4 minute studio loop and the SSE
// stream leaving WriteTimeout unset is meant to protect.
func newServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
}
