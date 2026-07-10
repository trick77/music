package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/trick77/music/internal/auth"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/httpapi"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
		log.Fatalf("mkdir db dir: %v", err)
	}
	if err := os.MkdirAll(cfg.MediaDir, 0o755); err != nil {
		log.Fatalf("mkdir media dir: %v", err)
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	var authr *auth.Authenticator
	if cfg.AuthMode == config.AuthModeOIDC {
		authr, err = auth.NewAuthenticator(context.Background(), cfg.OIDC)
		if err != nil {
			log.Fatalf("oidc init: %v", err)
		}
	}

	handler := httpapi.NewWithAuth(cfg, st, web.SPAHandler(), authr)
	log.Printf("music listening on %s (auth=%s)", cfg.ListenAddr, cfg.AuthMode)
	if err := http.ListenAndServe(cfg.ListenAddr, handler); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
