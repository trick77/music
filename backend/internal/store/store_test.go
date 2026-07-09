package store

import (
	"path/filepath"
	"testing"
)

func TestOpen_runsMigrations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	st, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open() error: %v", err)
	}
	defer st.Close()

	// Core tables must exist.
	for _, tbl := range []string{"songs", "artists", "genres", "song_genres", "playlists", "fanart", "plays", "schema_migrations"} {
		var name string
		err := st.DB().QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name)
		if err != nil {
			t.Fatalf("table %q missing: %v", tbl, err)
		}
	}

	// Re-opening must be idempotent (migrations already recorded).
	st2, err := Open(dbPath)
	if err != nil {
		t.Fatalf("re-Open() error: %v", err)
	}
	st2.Close()
}
