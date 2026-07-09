package media

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolve_rejectsEscapes(t *testing.T) {
	st, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, bad := range []string{"../secret", "/etc/passwd", "songs/../../secret", ""} {
		if _, err := st.Resolve(bad); err == nil {
			t.Fatalf("Resolve(%q) = nil error, want rejection", bad)
		}
	}
}

func TestResolve_acceptsInside(t *testing.T) {
	root := t.TempDir()
	st, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	abs, err := st.Resolve("songs/a.mp3")
	if err != nil {
		t.Fatalf("Resolve inside root: %v", err)
	}
	if !strings.HasPrefix(abs, st.rootReal) {
		t.Fatalf("resolved %q not under root %q", abs, st.rootReal)
	}
}

func TestResolve_rejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	st, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// A symlink INSIDE the root that points OUTSIDE it must not be a usable path.
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if _, err := st.Resolve("escape/secret.mp3"); err == nil {
		t.Fatal("Resolve through escaping symlink = nil error, want rejection")
	}
}

func TestCreateThenOpen_roundTrips(t *testing.T) {
	st, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f, err := st.Create("songs/x.mp3")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := f.WriteString("hello"); err != nil {
		t.Fatalf("Write: %v", err)
	}
	f.Close()

	rf, err := st.Open("songs/x.mp3")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer rf.Close()
	buf := make([]byte, 5)
	if _, err := rf.Read(buf); err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(buf) != "hello" {
		t.Fatalf("round-trip = %q, want hello", buf)
	}
}

func TestRemove_deletesAndToleratesMissing(t *testing.T) {
	st, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	f, err := st.Create("songs/gone.mp3")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	f.Close()
	if err := st.Remove("songs/gone.mp3"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := st.Open("songs/gone.mp3"); err == nil {
		t.Fatal("file still present after Remove")
	}
	// Removing a missing file is not an error.
	if err := st.Remove("songs/gone.mp3"); err != nil {
		t.Fatalf("Remove missing = %v, want nil", err)
	}
	// Unsafe paths are still rejected.
	if err := st.Remove("../escape"); err == nil {
		t.Fatal("Remove unsafe path = nil, want rejection")
	}
}
