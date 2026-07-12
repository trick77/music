package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigration0005_healsPaddedAlbumSiblings exercises 0005_normalize_album.sql
// against data a padded-album library accumulated before the fix: songs.album
// stored with surrounding whitespace, and a sibling that never received the
// album's mapped cover because the old bulk-apply matched on lower(album) (no
// trim). After the migration, album names are trimmed and every song of the
// mapped artist+album carries the shared cover.
func TestMigration0005_healsPaddedAlbumSiblings(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "album.db")
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

	// Schema up to and including 0004, but NOT 0005 yet.
	for _, m := range []string{
		"migrations/0001_init.sql",
		"migrations/0002_song_lyrics.sql",
		"migrations/0003_song_alignment.sql",
		"migrations/0004_lowercase_genres.sql",
	} {
		body, err := migrationsFS.ReadFile(m)
		if err != nil {
			t.Fatalf("read %s: %v", m, err)
		}
		exec(string(body))
	}

	exec(`INSERT INTO artists(id,name,name_key) VALUES('a1','A','a')`)
	exec(`INSERT INTO cover_art(id,image_path) VALUES('cov','covers/x.jpg')`)
	// The album is mapped to a cover (album_key already lower(trim)); the clean
	// sibling has it, but the padded sibling was skipped by the old query.
	exec(`INSERT INTO album_covers(artist_id,album_key,cover_art_id) VALUES('a1','album one','cov')`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path,cover_art_id) VALUES('s1','Clean','a1','Album One','songs/1.mp3','cov')`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s2','Trailing','a1','Album One ','songs/2.mp3')`)
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s3','Leading','a1',' Album One','songs/3.mp3')`)
	// A different album stays untouched.
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s4','Other','a1','Other','songs/4.mp3')`)
	// An all-whitespace album collapses to NULL (matches normalizeAlbum).
	exec(`INSERT INTO songs(id,title,artist_id,album,file_path) VALUES('s5','Blank','a1','   ','songs/5.mp3')`)

	mig, err := migrationsFS.ReadFile("migrations/0005_normalize_album.sql")
	if err != nil {
		t.Fatalf("read 0005: %v", err)
	}
	if _, err := db.Exec(string(mig)); err != nil {
		t.Fatalf("apply 0005: %v", err)
	}

	// All three Album One songs now carry the shared cover and a trimmed album.
	for _, id := range []string{"s1", "s2", "s3"} {
		var album string
		var cover sql.NullString
		if err := db.QueryRow(`SELECT album, cover_art_id FROM songs WHERE id=?`, id).Scan(&album, &cover); err != nil {
			t.Fatalf("row %s: %v", id, err)
		}
		if album != "Album One" {
			t.Fatalf("song %s album = %q, want %q", id, album, "Album One")
		}
		if cover.String != "cov" {
			t.Fatalf("song %s cover = %q, want cov", id, cover.String)
		}
	}

	// The unmapped album keeps no cover.
	var otherCover sql.NullString
	if err := db.QueryRow(`SELECT cover_art_id FROM songs WHERE id='s4'`).Scan(&otherCover); err != nil {
		t.Fatalf("row s4: %v", err)
	}
	if otherCover.Valid {
		t.Fatalf("other album wrongly covered: %q", otherCover.String)
	}

	// The all-whitespace album collapsed to NULL and got no cover.
	var blankAlbum sql.NullString
	var blankCover sql.NullString
	if err := db.QueryRow(`SELECT album, cover_art_id FROM songs WHERE id='s5'`).Scan(&blankAlbum, &blankCover); err != nil {
		t.Fatalf("row s5: %v", err)
	}
	if blankAlbum.Valid {
		t.Fatalf("whitespace album not collapsed to NULL: %q", blankAlbum.String)
	}
	if blankCover.Valid {
		t.Fatalf("blank-album song wrongly covered: %q", blankCover.String)
	}
}
