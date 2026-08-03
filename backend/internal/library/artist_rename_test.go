package library

import (
	"context"
	"testing"
)

// artists.name_key is UNIQUE and case-folded, so two spellings of one artist can
// never coexist. That makes a case-only correction ("SIngers" -> "Singers") either
// win library-wide or be dropped entirely — these tests pin down which, and pin the
// deliberate asymmetry between the edit path (renames) and the upload path (doesn't).

func updateParamsFrom(s *Song) UpdateSongParams {
	return UpdateSongParams{
		Title:      s.Title,
		ArtistName: s.ArtistName,
		Album:      s.Album,
		Year:       s.Year,
		TrackNo:    s.TrackNo,
		Genres:     s.Genres,
		Lyrics:     s.Lyrics,
		FileSize:   s.FileSize,
	}
}

func artistRow(t *testing.T, r *Repo, key string) (id, name string, count int) {
	t.Helper()
	ctx := context.Background()
	if err := r.db.QueryRowContext(ctx,
		`SELECT count(*) FROM artists WHERE name_key = ?`, key).Scan(&count); err != nil {
		t.Fatalf("count artists: %v", err)
	}
	if count == 0 {
		return "", "", 0
	}
	if err := r.db.QueryRowContext(ctx,
		`SELECT id, name FROM artists WHERE name_key = ?`, key).Scan(&id, &name); err != nil {
		t.Fatalf("select artist: %v", err)
	}
	return id, name, count
}

func TestUpdate_caseOnlyArtistRename_persistsAndKeepsOneArtist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p := sampleParams()
	p.ArtistName = "SIngers"
	song, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	beforeID, _, _ := artistRow(t, r, "singers")

	edit := updateParamsFrom(song)
	edit.ArtistName = "Singers"
	updated, err := r.Update(ctx, song.ID, edit)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	// The bug this guards: the lookup hit on name_key and returned early, so the
	// response echoed back the old spelling and the row never changed.
	if updated.ArtistName != "Singers" {
		t.Errorf("returned artist = %q, want %q", updated.ArtistName, "Singers")
	}
	afterID, name, count := artistRow(t, r, "singers")
	if name != "Singers" {
		t.Errorf("stored artists.name = %q, want %q", name, "Singers")
	}
	if count != 1 {
		t.Errorf("artists rows for key singers = %d, want 1", count)
	}
	if afterID != beforeID {
		t.Errorf("artist id changed: %q -> %q, want it stable", beforeID, afterID)
	}

	// A case fix is a display-only change, so the song must still point at the same artist.
	reread, err := r.Get(ctx, song.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if reread.ArtistID != song.ArtistID {
		t.Errorf("song artist_id changed: %q -> %q", song.ArtistID, reread.ArtistID)
	}
	if reread.ArtistName != "Singers" {
		t.Errorf("reread artist = %q, want %q", reread.ArtistName, "Singers")
	}
}

func TestUpdate_caseOnlyArtistRename_appliesToSiblingSongs(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p1 := sampleParams()
	p1.ArtistName = "SIngers"
	first, err := r.Create(ctx, NewID(), p1)
	if err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	p2 := sampleParams()
	p2.ArtistName = "SIngers"
	p2.Title = "Second Song"
	p2.ContentHash = "hash-b"
	p2.FilePath = "songs/b.mp3"
	second, err := r.Create(ctx, NewID(), p2)
	if err != nil {
		t.Fatalf("Create 2: %v", err)
	}

	edit := updateParamsFrom(first)
	edit.ArtistName = "Singers"
	if _, err := r.Update(ctx, first.ID, edit); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// One artist row, one name: the fix is library-wide by construction, not incidental.
	sibling, err := r.Get(ctx, second.ID)
	if err != nil {
		t.Fatalf("Get sibling: %v", err)
	}
	if sibling.ArtistName != "Singers" {
		t.Errorf("sibling artist = %q, want %q", sibling.ArtistName, "Singers")
	}
}

func TestUpdate_differentArtistName_createsSeparateArtist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p := sampleParams()
	p.ArtistName = "Singers"
	song, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	edit := updateParamsFrom(song)
	edit.ArtistName = "The Singers"
	updated, err := r.Update(ctx, song.ID, edit)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}

	if updated.ArtistName != "The Singers" {
		t.Errorf("returned artist = %q, want %q", updated.ArtistName, "The Singers")
	}
	if updated.ArtistID == song.ArtistID {
		t.Error("artist id unchanged, want a new artist for a genuinely different name")
	}
	// A rename must not rewrite the artist the song moved away from.
	if _, name, count := artistRow(t, r, "singers"); name != "Singers" || count != 1 {
		t.Errorf("old artist = %q (count %d), want %q left intact", name, count, "Singers")
	}
}

func TestCreate_differentlyCasedTag_doesNotRestyleExistingArtist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p1 := sampleParams()
	p1.ArtistName = "Singers"
	if _, err := r.Create(ctx, NewID(), p1); err != nil {
		t.Fatalf("Create 1: %v", err)
	}

	// An upload only reports what its ID3 tag happens to say — it must not restyle
	// an artist the library already knows.
	p2 := sampleParams()
	p2.ArtistName = "SINGERS"
	p2.ContentHash = "hash-b"
	p2.FilePath = "songs/b.mp3"
	uploaded, err := r.Create(ctx, NewID(), p2)
	if err != nil {
		t.Fatalf("Create 2: %v", err)
	}

	if uploaded.ArtistName != "Singers" {
		t.Errorf("uploaded song artist = %q, want the curated %q", uploaded.ArtistName, "Singers")
	}
	if _, name, count := artistRow(t, r, "singers"); name != "Singers" || count != 1 {
		t.Errorf("artists.name = %q (count %d), want %q untouched", name, count, "Singers")
	}
}
