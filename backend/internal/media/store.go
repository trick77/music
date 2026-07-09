// Package media is the managed audio/image store: it owns file organization
// under a single root and guarantees every path stays sandboxed inside it.
package media

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ErrUnsafePath is returned when a store-relative path would escape the root.
var ErrUnsafePath = errors.New("media: unsafe path")

type Store struct {
	rootReal string // root with symlinks resolved; the sandbox boundary
}

// New ensures root exists and records its symlink-resolved absolute form.
func New(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("media: empty root")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	return &Store{rootReal: real}, nil
}

// Resolve maps a store-relative path to an absolute path under the root,
// rejecting absolute inputs, ".." traversal, and symlink escape.
func (s *Store) Resolve(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", ErrUnsafePath
	}
	// Reject any ".." segment outright (spec §14), rather than silently
	// collapsing it to an in-root path.
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if seg == ".." {
			return "", ErrUnsafePath
		}
	}
	// Clean("/"+rel) collapses any ".." against a virtual root, so no cleaned
	// path can climb above "/"; we then rejoin under the real root.
	clean := filepath.Clean("/" + rel)
	abs := filepath.Join(s.rootReal, strings.TrimPrefix(clean, string(os.PathSeparator)))
	if abs != s.rootReal && !strings.HasPrefix(abs, s.rootReal+string(os.PathSeparator)) {
		return "", ErrUnsafePath
	}
	// Defend against symlink escape: resolve the longest existing ancestor and
	// confirm it still sits inside the root.
	if real, err := longestReal(abs); err == nil {
		if real != s.rootReal && !strings.HasPrefix(real, s.rootReal+string(os.PathSeparator)) {
			return "", ErrUnsafePath
		}
	}
	return abs, nil
}

// longestReal walks up from p to the nearest existing ancestor, resolves its
// symlinks, and reattaches the non-existent tail.
func longestReal(p string) (string, error) {
	tail := ""
	cur := p
	for {
		if real, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(real, tail), nil
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", os.ErrNotExist
		}
		tail = filepath.Join(filepath.Base(cur), tail)
		cur = parent
	}
}

// Create opens rel for writing, creating parent directories as needed.
func (s *Store) Create(rel string) (*os.File, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	return os.Create(abs)
}

// Open opens rel for reading.
func (s *Store) Open(rel string) (*os.File, error) {
	abs, err := s.Resolve(rel)
	if err != nil {
		return nil, err
	}
	return os.Open(abs)
}

// Remove deletes rel from the store. A missing file is not an error, so callers
// can use it for best-effort cleanup of a partially-written import.
func (s *Store) Remove(rel string) error {
	abs, err := s.Resolve(rel)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
