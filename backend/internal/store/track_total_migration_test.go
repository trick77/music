package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigration0007_backfillsTrackTotals exercises 0007_track_total.sql against a
// library that predates "N of Y" numbering: songs carry stale/absent track_no and
// no track_total. After the migration every artist+album group is numbered 1..N by
// rowid (add order) with track_total=N, groups are keyed on (artist_id,
// lower(trim(album))) so the same album title under two artists stays separate, and
// singles (empty album) are left untouched.
func TestMigration0007_backfillsTrackTotals(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "track.db")
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

	// Schema up to and including 0006, but NOT 0007 yet.
	for _, m := range []string{
		"migrations/0001_init.sql",
		"migrations/0002_song_lyrics.sql",
		"migrations/0003_song_alignment.sql",
		"migrations/0004_lowercase_genres.sql",
		"migrations/0005_normalize_album.sql",
		"migrations/0006_song_audio_info.sql",
	} {
		body, err := migrationsFS.ReadFile(m)
		if err != nil {
			t.Fatalf("read %s: %v", m, err)
		}
		exec(string(body))
	}

	exec(`INSERT INTO artists(id,name,name_key) VALUES('a1','A','a')`)
	exec(`INSERT INTO artists(id,name,name_key) VALUES('a2','B','b')`)

	// Group (a1, "album one"): inserted in add order s1,s2,s3 with stale track_no
	// that must be overwritten. s3 uses a different-case spelling to prove grouping
	// is case-insensitive (lower(trim(album))).
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path,track_no) VALUES('s1','One','a1','Album One','songs/1.mp3',7)`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path,track_no) VALUES('s2','Two','a1','Album One','songs/2.mp3',7)`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path,track_no) VALUES('s3','Three','a1','album one','songs/3.mp3',7)`)
	// Group (a2, "album one"): same album title, different artist — a separate group.
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s4','B-One','a2','Album One','songs/4.mp3')`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s5','B-Two','a2','Album One','songs/5.mp3')`)
	// A single: NULL album, a leftover track_no. Must stay untouched, total NULL.
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path,track_no) VALUES('s6','Solo','a1',NULL,'songs/6.mp3',5)`)

	mig, err := migrationsFS.ReadFile("migrations/0007_track_total.sql")
	if err != nil {
		t.Fatalf("read 0007: %v", err)
	}
	if _, err := db.Exec(string(mig)); err != nil {
		t.Fatalf("apply 0007: %v", err)
	}

	want := func(id string, no, total int64) {
		t.Helper()
		var gotNo, gotTotal sql.NullInt64
		if err := db.QueryRow(`SELECT track_no, track_total FROM songs WHERE id=?`, id).Scan(&gotNo, &gotTotal); err != nil {
			t.Fatalf("row %s: %v", id, err)
		}
		if gotNo.Int64 != no || gotTotal.Int64 != total {
			t.Fatalf("song %s = %d of %d, want %d of %d", id, gotNo.Int64, gotTotal.Int64, no, total)
		}
	}

	// a1/Album One → 1,2,3 of 3 by add order.
	want("s1", 1, 3)
	want("s2", 2, 3)
	want("s3", 3, 3)
	// a2/Album One is its own group of 2.
	want("s4", 1, 2)
	want("s5", 2, 2)

	// The single is untouched: original track_no kept, no total.
	var soloNo, soloTotal sql.NullInt64
	if err := db.QueryRow(`SELECT track_no, track_total FROM songs WHERE id='s6'`).Scan(&soloNo, &soloTotal); err != nil {
		t.Fatalf("row s6: %v", err)
	}
	if soloNo.Int64 != 5 {
		t.Fatalf("single track_no = %d, want 5 (untouched)", soloNo.Int64)
	}
	if soloTotal.Valid {
		t.Fatalf("single track_total = %d, want NULL", soloTotal.Int64)
	}
}
