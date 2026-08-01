package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// applyMigrations replays the named migrations onto a bare DB in order, so a test
// can assert what a single migration does rather than what Open() produces.
func applyMigrations(t *testing.T, db *sql.DB, names ...string) {
	t.Helper()
	for _, n := range names {
		body, err := migrationsFS.ReadFile("migrations/" + n)
		if err != nil {
			t.Fatalf("read %s: %v", n, err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("apply %s: %v", n, err)
		}
	}
}

// TestMigration0008_createsStudioHistory exercises 0008_studio_history.sql: a row
// written with only the required columns must come back with usable defaults —
// empty JSON arrays (not NULL, which would break the unconditional
// json.Unmarshal in library/studio_history.go) and a zero refine count.
func TestMigration0008_createsStudioHistory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "history.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	applyMigrations(t, db,
		"0001_init.sql", "0002_song_lyrics.sql", "0003_song_alignment.sql",
		"0004_lowercase_genres.sql", "0005_normalize_album.sql",
		"0006_song_audio_info.sql", "0007_track_total.sql",
		"0008_studio_history.sql",
	)

	if _, err := db.Exec(
		`INSERT INTO studio_history(id, reference, style_prompt, lyrics, cover_art_prompt)
		 VALUES('abc','Metallica, Enter Sandman','1991,thrash metal','[Verse]','a door')`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	var genres, bands, titles, albums string
	var refines int
	var createdAt, updatedAt string
	var artist, title string
	if err := db.QueryRow(
		`SELECT genres, bands, titles, albums, refine_count, created_at, updated_at,
		        reference_artist, reference_title
		 FROM studio_history WHERE id='abc'`).
		Scan(&genres, &bands, &titles, &albums, &refines, &createdAt, &updatedAt, &artist, &title); err != nil {
		t.Fatalf("select: %v", err)
	}
	for name, got := range map[string]string{"genres": genres, "bands": bands, "titles": titles, "albums": albums} {
		if got != "[]" {
			t.Fatalf("%s default = %q, want %q", name, got, "[]")
		}
	}
	if refines != 0 {
		t.Fatalf("refine_count default = %d, want 0", refines)
	}
	if createdAt == "" || updatedAt == "" {
		t.Fatalf("timestamps = %q / %q, want both defaulted", createdAt, updatedAt)
	}
	// The label columns default to empty, never NULL: the read side scans them
	// into plain strings.
	if artist != "" || title != "" {
		t.Fatalf("reference labels = %q / %q, want both empty", artist, title)
	}

	// coverart_id is the one nullable column — a run has no cover until one is
	// generated for it.
	var coverArt sql.NullString
	if err := db.QueryRow(`SELECT coverart_id FROM studio_history WHERE id='abc'`).Scan(&coverArt); err != nil {
		t.Fatalf("select coverart_id: %v", err)
	}
	if coverArt.Valid {
		t.Fatalf("coverart_id = %q, want NULL", coverArt.String)
	}
}
