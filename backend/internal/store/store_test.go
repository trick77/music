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

func TestOpen_squashedSchemaHasPhase4Objects(t *testing.T) {
	st, err := Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	// The album_covers table (was 0003) must exist in the single init migration.
	var name string
	err = st.DB().QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='album_covers'`).Scan(&name)
	if err != nil {
		t.Fatalf("album_covers table missing: %v", err)
	}

	// The content-hash unique index (was 0002) and the new playlist-order index.
	for _, idx := range []string{"idx_songs_content_hash", "idx_playlist_songs_order"} {
		var got string
		err := st.DB().QueryRow(
			`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&got)
		if err != nil {
			t.Fatalf("index %s missing: %v", idx, err)
		}
	}

	// Three migrations recorded: the squash (0001), the song publish gate (0002),
	// and the playlist publish gate (0003).
	var count int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != 3 {
		t.Fatalf("expected 3 recorded migrations, got %d", count)
	}
}
