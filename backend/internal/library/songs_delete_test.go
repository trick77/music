package library

import (
	"context"
	"testing"
)

func TestDeleteSong_cascadesAndReturnsPath(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO artists(id,name,name_key) VALUES('ar1','A','a')`)
	mustExec(t, r, `INSERT INTO songs(id,title,artist_id,file_path) VALUES('s1','T','ar1','songs/s1.mp3')`)
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Rock')`)
	mustExec(t, r, `INSERT INTO song_genres(song_id,genre_id) VALUES('s1','g1')`)
	mustExec(t, r, `INSERT INTO plays(id,song_id) VALUES('p1','s1')`)
	mustExec(t, r, `INSERT INTO playlists(id,name) VALUES('pl1','P')`)
	mustExec(t, r, `INSERT INTO playlist_songs(playlist_id,song_id,position) VALUES('pl1','s1',0)`)

	path, existed, err := r.DeleteSong(ctx, "s1")
	if err != nil || !existed {
		t.Fatalf("delete: existed=%v err=%v", existed, err)
	}
	if path != "songs/s1.mp3" {
		t.Fatalf("path = %q, want songs/s1.mp3", path)
	}
	for _, q := range []string{
		`SELECT count(*) FROM songs WHERE id='s1'`,
		`SELECT count(*) FROM song_genres WHERE song_id='s1'`,
		`SELECT count(*) FROM plays WHERE song_id='s1'`,
		`SELECT count(*) FROM playlist_songs WHERE song_id='s1'`,
	} {
		var n int
		if err := r.db.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if n != 0 {
			t.Fatalf("%q: got %d rows, want 0 (cascade failed)", q, n)
		}
	}
}

func TestDeleteSong_missingReturnsFalse(t *testing.T) {
	r := newRepo(t)
	path, existed, err := r.DeleteSong(context.Background(), "nope")
	if err != nil || existed || path != "" {
		t.Fatalf("got (%q,%v,%v), want (\"\",false,nil)", path, existed, err)
	}
}
