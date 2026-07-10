package library

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func mustExec(t *testing.T, r *Repo, sql string) {
	t.Helper()
	if _, err := r.db.ExecContext(context.Background(), sql); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

func TestMigration_fanartAndGenreImageryColumns(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// genres.accent_color exists and is nullable.
	if _, err := r.db.ExecContext(ctx, `INSERT INTO genres(id,name,accent_color) VALUES('g1','Jazz','#334455')`); err != nil {
		t.Fatalf("genres.accent_color: %v", err)
	}
	// fanart has the new columns with a status CHECK.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,genre_id,status,width,height,seed) VALUES('f1','fanart/f1.jpg','genre','g1','generating',0,0,42)`); err != nil {
		t.Fatalf("fanart new columns: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO fanart(id,image_path,kind,status) VALUES('f2','','hero','bogus')`); err == nil {
		t.Fatal("expected status CHECK to reject 'bogus'")
	}
}

func TestFanart_createGetAndJSONScrub(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	seed := int64(7)
	id, err := r.CreateFanart(ctx, FanartParams{
		Kind: "genre", GenreID: "g1", ImagePath: "fanart/x.jpg", Status: "ready",
		Width: 1344, Height: 768, Prompt: "a smoky club", Model: "flux-2-klein-4b", Seed: &seed,
	})
	if err != nil {
		t.Fatal(err)
	}
	fa, err := r.GetFanart(ctx, id)
	if err != nil || fa == nil {
		t.Fatalf("GetFanart: %v", err)
	}
	if fa.Prompt != "a smoky club" || fa.Model == "" || fa.ImagePath == "" {
		t.Fatalf("server-only fields missing: %#v", fa)
	}
	// The JSON encoding must NOT contain prompt/model/image_path (no-AI-in-UI + sandbox).
	b, _ := json.Marshal(fa)
	for _, banned := range []string{"smoky club", "flux", "fanart/x.jpg", "prompt", "model", "imagePath"} {
		if strings.Contains(string(b), banned) {
			t.Fatalf("Fanart JSON leaked %q: %s", banned, b)
		}
	}
}

func TestFanart_generatingToReadyAndFailed(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	a, _ := r.CreateGeneratingFanart(ctx, "genre", "g1", "p", "m", nil)
	if fa, _ := r.GetFanart(ctx, a); fa.Status != "generating" {
		t.Fatalf("status = %q", fa.Status)
	}
	if err := r.MarkFanartReady(ctx, a, "fanart/a.jpg", 1344, 768); err != nil {
		t.Fatal(err)
	}
	if fa, _ := r.GetFanart(ctx, a); fa.Status != "ready" || fa.Width != 1344 {
		t.Fatalf("ready = %#v", fa)
	}
	b, _ := r.CreateGeneratingFanart(ctx, "genre", "g1", "p", "m", nil)
	if err := r.MarkFanartFailed(ctx, b, "request moderated"); err != nil {
		t.Fatal(err)
	}
	if fa, _ := r.GetFanart(ctx, b); fa.Status != "failed" || fa.ErrorMsg != "request moderated" {
		t.Fatalf("failed = %#v", fa)
	}
}

func TestFanart_activeBackgroundExclusiveAndAccent(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "fanart/1.jpg", Status: "ready"})
	f2, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "fanart/2.jpg", Status: "ready"})
	if err := r.SetActiveBackground(ctx, "g1", f1); err != nil {
		t.Fatal(err)
	}
	if err := r.SetActiveBackground(ctx, "g1", f2); err != nil {
		t.Fatal(err)
	}
	list, _ := r.ListGenreFanart(ctx, "g1")
	active := 0
	for _, fa := range list {
		if fa.IsActive {
			active++
			if fa.ID != f2 {
				t.Fatalf("wrong active: %s", fa.ID)
			}
		}
	}
	if active != 1 {
		t.Fatalf("active count = %d, want 1", active)
	}
	if err := r.SetGenreAccent(ctx, "g1", "#abcdef"); err != nil {
		t.Fatal(err)
	}
	g, _, _ := r.GetGenre(ctx, "g1")
	if g.AccentColor != "#abcdef" {
		t.Fatalf("accent = %q", g.AccentColor)
	}
}

func TestFanart_heroIsGlobalExclusive(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "a", Status: "ready"})
	f2, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "b", Status: "ready"})
	if err := r.SetHero(ctx, f1); err != nil {
		t.Fatal(err)
	}
	if err := r.SetHero(ctx, f2); err != nil {
		t.Fatal(err)
	}
	a, _ := r.GetFanart(ctx, f1)
	b, _ := r.GetFanart(ctx, f2)
	if a.IsHero || !b.IsHero {
		t.Fatalf("hero exclusivity broken: a=%v b=%v", a.IsHero, b.IsHero)
	}
}

func TestSetActiveBackground_rejectsForeignFanart(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mustExec(t, r, `INSERT INTO genres(id,name) VALUES('g1','Jazz'),('g2','Rock')`)
	f1, _ := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: "g1", ImagePath: "a", Status: "ready"})
	if err := r.SetActiveBackground(ctx, "g2", f1); !errors.Is(err, ErrFanartNotInGenre) {
		t.Fatalf("err = %v, want ErrFanartNotInGenre", err)
	}
}
