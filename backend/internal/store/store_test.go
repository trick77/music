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

	// The content-hash unique index, the playlist-order index, and the publish-gate
	// indexes (all folded into the single init migration).
	for _, idx := range []string{"idx_songs_content_hash", "idx_playlist_songs_order", "idx_songs_published", "idx_playlists_published"} {
		var got string
		err := st.DB().QueryRow(
			`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&got)
		if err != nil {
			t.Fatalf("index %s missing: %v", idx, err)
		}
	}

	// The favorites table (folded from former 0004) must exist.
	if err := st.DB().QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name='favorites'`).Scan(&name); err != nil {
		t.Fatalf("favorites table missing: %v", err)
	}

	// The is_published publish-gate columns (folded from former 0002/0003) exist.
	for _, tbl := range []string{"songs", "playlists"} {
		var got string
		err := st.DB().QueryRow(
			`SELECT name FROM pragma_table_info(?) WHERE name='is_published'`, tbl).Scan(&got)
		if err != nil {
			t.Fatalf("%s.is_published column missing: %v", tbl, err)
		}
	}

	// The songs.lyrics column (0002_song_lyrics) exists.
	var lyricsCol string
	if err := st.DB().QueryRow(
		`SELECT name FROM pragma_table_info('songs') WHERE name='lyrics'`).Scan(&lyricsCol); err != nil {
		t.Fatalf("songs.lyrics column missing: %v", err)
	}

	// Seven migrations recorded: the 0001 squash, 0002_song_lyrics add-column,
	// 0003_song_alignment, 0004_lowercase_genres, 0005_normalize_album,
	// 0006_song_audio_info, and 0007_track_total.
	var count int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != 7 {
		t.Fatalf("expected 7 recorded migrations, got %d", count)
	}
}
