package library

import (
	"context"
	"testing"
)

// playAt inserts one play row at an explicit timestamp, so these tests never
// depend on the wall clock.
func playAt(t *testing.T, r *Repo, songID, at string) {
	t.Helper()
	_, err := r.db.ExecContext(context.Background(),
		`INSERT INTO plays(id, song_id, played_at) VALUES(?, ?, ?)`, NewID(), songID, at)
	if err != nil {
		t.Fatalf("insert play at %s: %v", at, err)
	}
}

// SongStats is LIFETIME, deliberately unlike TopTen's rolling 30-day window: on a
// single song's Info tab "248 plays" should mean 248 plays ever, not 248 this month.
func TestSongStats_CountsLifetimeNotTheChartWindow(t *testing.T) {
	r := newRepo(t)
	id := seedSong(t, r, "Counted")

	playAt(t, r, id, "2019-03-03 03:03:03")
	playAt(t, r, id, "2020-01-01 00:00:00")
	playAt(t, r, id, "2024-06-15 12:00:00")

	st, err := r.SongStats(context.Background(), id)
	if err != nil {
		t.Fatalf("SongStats: %v", err)
	}
	if st.Plays != 3 {
		t.Errorf("Plays = %d, want 3 — every play counts, not just the last 30 days", st.Plays)
	}
	if st.LastPlayedAt != "2024-06-15 12:00:00" {
		t.Errorf("LastPlayedAt = %q, want the most recent play", st.LastPlayedAt)
	}
}

func TestSongStats_NeverPlayed(t *testing.T) {
	r := newRepo(t)
	id := seedSong(t, r, "Unheard")

	st, err := r.SongStats(context.Background(), id)
	if err != nil {
		t.Fatalf("SongStats: %v", err)
	}
	if st.Plays != 0 {
		t.Errorf("Plays = %d, want 0", st.Plays)
	}
	if st.LastPlayedAt != "" {
		t.Errorf("LastPlayedAt = %q, want empty for a song nobody has played", st.LastPlayedAt)
	}
}

// Plays of other songs must not leak into this song's count.
func TestSongStats_ScopedToTheSong(t *testing.T) {
	r := newRepo(t)
	mine := seedSong(t, r, "Mine")
	other := seedSong(t, r, "Other")

	playAt(t, r, mine, "2024-01-01 00:00:00")
	playAt(t, r, other, "2024-01-02 00:00:00")
	playAt(t, r, other, "2024-01-03 00:00:00")

	st, err := r.SongStats(context.Background(), mine)
	if err != nil {
		t.Fatalf("SongStats: %v", err)
	}
	if st.Plays != 1 {
		t.Errorf("Plays = %d, want 1 — other songs' plays must not count", st.Plays)
	}
}
