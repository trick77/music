package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigration0004_mergesCaseDuplicateGenres exercises the merge path of
// 0004_lowercase_genres.sql against seeded collision data — the case a fresh
// (empty) DB never reaches. A pre-existing "Rock"/"rock" pair (only possible via
// the raw rename path) must collapse to one lowercase genre with associations and
// is_primary preserved; otherwise the naive lowercase would trip UNIQUE(name) and
// the migration — and app boot — would fail.
func TestMigration0004_mergesCaseDuplicateGenres(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "merge.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatalf("exec %q: %v", q, err)
		}
	}

	// Build the schema from 0001, then seed a collision BEFORE 0004 runs.
	init0001, err := migrationsFS.ReadFile("migrations/0001_init.sql")
	if err != nil {
		t.Fatalf("read 0001: %v", err)
	}
	exec(string(init0001))

	exec(`INSERT INTO artists(id,name,name_key) VALUES('a1','A','a')`)
	exec(`INSERT INTO songs(id,title,artist_id,file_path) VALUES('s1','T','a1','songs/s.mp3')`)
	// Survivor is MIN(id); 'g_a' < 'g_b'. The loser ('g_b','rock') holds is_primary.
	exec(`INSERT INTO genres(id,name) VALUES('g_a','Rock'),('g_b','rock')`)
	exec(`INSERT INTO song_genres(song_id,genre_id,is_primary) VALUES('s1','g_a',0),('s1','g_b',1)`)
	exec(`INSERT INTO fanart(id,image_path,kind,genre_id) VALUES('f1','p.jpg','genre','g_b')`)

	// Apply the migration under test.
	mig0004, err := migrationsFS.ReadFile("migrations/0004_lowercase_genres.sql")
	if err != nil {
		t.Fatalf("read 0004: %v", err)
	}
	if _, err := db.Exec(string(mig0004)); err != nil {
		t.Fatalf("apply 0004: %v", err)
	}

	// Exactly one genre survives, lowercased, keeping the survivor id.
	var gid, gname string
	if err := db.QueryRow(`SELECT id, name FROM genres`).Scan(&gid, &gname); err != nil {
		t.Fatalf("genres row: %v", err)
	}
	if gid != "g_a" || gname != "rock" {
		t.Fatalf("survivor = (%q,%q), want (g_a,rock)", gid, gname)
	}
	var genreCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM genres`).Scan(&genreCount); err != nil {
		t.Fatalf("count genres: %v", err)
	}
	if genreCount != 1 {
		t.Fatalf("genre count = %d, want 1", genreCount)
	}

	// The song is linked exactly once, to the survivor, and is_primary is preserved.
	var linkGid string
	var isPrimary int
	var linkCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM song_genres WHERE song_id='s1'`).Scan(&linkCount); err != nil {
		t.Fatalf("count links: %v", err)
	}
	if linkCount != 1 {
		t.Fatalf("song_genres count = %d, want 1", linkCount)
	}
	if err := db.QueryRow(`SELECT genre_id, is_primary FROM song_genres WHERE song_id='s1'`).Scan(&linkGid, &isPrimary); err != nil {
		t.Fatalf("link row: %v", err)
	}
	if linkGid != "g_a" || isPrimary != 1 {
		t.Fatalf("link = (%q, is_primary=%d), want (g_a, 1)", linkGid, isPrimary)
	}

	// Fanart was re-pointed onto the survivor.
	var fanartGid string
	if err := db.QueryRow(`SELECT genre_id FROM fanart WHERE id='f1'`).Scan(&fanartGid); err != nil {
		t.Fatalf("fanart row: %v", err)
	}
	if fanartGid != "g_a" {
		t.Fatalf("fanart genre_id = %q, want g_a", fanartGid)
	}
}
