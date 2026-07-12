// Package store opens the SQLite database and applies embedded migrations.
package store

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"sort"

	_ "github.com/ncruces/go-sqlite3/driver"
	_ "github.com/ncruces/go-sqlite3/embed"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct{ db *sql.DB }

func (s *Store) DB() *sql.DB  { return s.db }
func (s *Store) Close() error { return s.db.Close() }

func Open(dbPath string) (*Store, error) {
	// busy_timeout must come first: the ncruces driver only applies its default
	// 1-minute busy timeout when NO _pragma is given, so specifying any pragma opts
	// out of it. Without a timeout, a writer that loses the single-writer race (WAL
	// allows one writer at a time) fails immediately with "database is locked"
	// instead of waiting — retry for up to 10s instead.
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		var exists string
		err := s.db.QueryRow(`SELECT name FROM schema_migrations WHERE name=?`, name).Scan(&exists)
		if err == nil {
			continue // already applied
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		body, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if err := s.applyMigration(name, string(body)); err != nil {
			return err
		}
	}
	return nil
}

// applyMigration runs one migration and records it in a single transaction, so
// a migration that fails partway leaves no partial schema and no orphan record.
func (s *Store) applyMigration(name, body string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(body); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if _, err := tx.Exec(`INSERT INTO schema_migrations(name) VALUES (?)`, name); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}
	return nil
}
