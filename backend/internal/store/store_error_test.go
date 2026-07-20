package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// Open must surface (not swallow) a database it cannot even create. sql.Open is
// lazy, so the failure only shows up on migrate's first statement.
func TestOpen_undialableDatabaseReturnsError(t *testing.T) {
	// A parent directory that does not exist: SQLite cannot create the file.
	dbPath := filepath.Join(t.TempDir(), "no-such-dir", "test.db")
	st, err := Open(dbPath)
	if err == nil {
		st.Close()
		t.Fatal("expected Open to fail for an uncreatable database path")
	}
	if !strings.Contains(err.Error(), "schema_migrations") {
		t.Fatalf("error should name the failing step, got %v", err)
	}
}

// A migration that fails partway must leave NO partial schema and NO ledger
// entry — that is the whole point of running body+record in one transaction.
// Colliding with an object 0001_init creates forces exactly that failure.
func TestOpen_failedMigrationRollsBackAndRecordsNothing(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")

	// Pre-create a table 0001_init also creates, but NOT the first one it creates,
	// so the migration gets partway through before colliding.
	seed, err := sql.Open("sqlite3", "file:"+dbPath)
	if err != nil {
		t.Fatalf("seed open: %v", err)
	}
	if _, err := seed.Exec(`CREATE TABLE artists (id TEXT PRIMARY KEY)`); err != nil {
		t.Fatalf("seed table: %v", err)
	}
	seed.Close()

	st, err := Open(dbPath)
	if err == nil {
		st.Close()
		t.Fatal("expected Open to fail when a migration collides with existing schema")
	}
	if !strings.Contains(err.Error(), "apply migration 0001_init.sql") {
		t.Fatalf("error should name the failing migration, got %v", err)
	}

	// Re-open the raw database and prove the rollback was complete.
	check, err := sql.Open("sqlite3", "file:"+dbPath)
	if err != nil {
		t.Fatalf("verify open: %v", err)
	}
	defer check.Close()

	// schema_meta is created by 0001_init BEFORE the colliding artists table.
	// If it survives, the migration was not atomic.
	var name string
	err = check.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'`).Scan(&name)
	if err == nil {
		t.Fatal("schema_meta survived a failed migration: the migration was not rolled back")
	}

	// And no ledger row may claim the migration succeeded.
	var count int
	if err := check.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count migrations: %v", err)
	}
	if count != 0 {
		t.Fatalf("failed migration recorded %d ledger rows, want 0", count)
	}
}

// A pre-existing schema_migrations table of the wrong shape must be reported,
// not silently treated as "nothing applied yet" — re-running every migration
// over a populated database would be far worse than failing loudly.
func TestOpen_unreadableLedgerIsReported(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")

	seed, err := sql.Open("sqlite3", "file:"+dbPath)
	if err != nil {
		t.Fatalf("seed open: %v", err)
	}
	// CREATE TABLE IF NOT EXISTS will leave this alone, so the ledger probe hits
	// a table with no "name" column.
	if _, err := seed.Exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("seed ledger: %v", err)
	}
	seed.Close()

	st, err := Open(dbPath)
	if err == nil {
		st.Close()
		t.Fatal("expected Open to fail on an unreadable schema_migrations ledger")
	}
	if !strings.Contains(err.Error(), "check migration") {
		t.Fatalf("error should name the ledger check, got %v", err)
	}
}
