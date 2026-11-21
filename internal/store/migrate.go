package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// MigrationNamePattern is the required file name form.
var MigrationNamePattern = regexp.MustCompile(`^(\d+)_(\d+)_[a-z0-9_]+\.sql$`)

type Migration struct {
	Name   string
	Ticket int
	Seq    int
	SQL    string
}

// Migrations returns every embedded migration in apply order.
func Migrations() ([]Migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	var out []Migration
	for _, e := range entries {
		m := MigrationNamePattern.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, fmt.Errorf("migration %q: name must match %s", e.Name(), MigrationNamePattern)
		}
		body, err := migrationFiles.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		ticket, _ := strconv.Atoi(m[1])
		seq, _ := strconv.Atoi(m[2])
		out = append(out, Migration{Name: e.Name(), Ticket: ticket, Seq: seq, SQL: string(body)})
	}
	slices.SortFunc(out, func(a, b Migration) int {
		if a.Ticket != b.Ticket {
			return a.Ticket - b.Ticket
		}
		if a.Seq != b.Seq {
			return a.Seq - b.Seq
		}
		if a.Name < b.Name {
			return -1
		}
		return 1
	})
	for i := 1; i < len(out); i++ {
		if out[i].Ticket == out[i-1].Ticket && out[i].Seq == out[i-1].Seq {
			return nil, fmt.Errorf("migrations %q and %q share ticket and seq", out[i-1].Name, out[i].Name)
		}
	}
	return out, nil
}

type MigrationResult struct {
	Applied []string // newly applied this time, in order
	Total   int      // applied overall after this run
	// Changed lists applied migrations whose file content differs from
	// what was applied (a shipped migration was edited; it is not re-run).
	Changed []string
}

// Migrate applies every embedded migration not yet applied, each in its own
// transaction.
func (db *DB) Migrate(ctx context.Context) (MigrationResult, error) {
	var res MigrationResult
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		name TEXT PRIMARY KEY,
		checksum TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return res, fmt.Errorf("create schema_migrations: %w", err)
	}
	applied := map[string]string{}
	rows, err := db.QueryContext(ctx, `SELECT name, checksum FROM schema_migrations`)
	if err != nil {
		return res, err
	}
	for rows.Next() {
		var name, sum string
		if err := rows.Scan(&name, &sum); err != nil {
			rows.Close()
			return res, err
		}
		applied[name] = sum
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}

	all, err := Migrations()
	if err != nil {
		return res, err
	}
	for _, m := range all {
		sum := checksum(m.SQL)
		if prev, ok := applied[m.Name]; ok {
			if prev != sum {
				res.Changed = append(res.Changed, m.Name)
			}
			continue
		}
		err := db.Tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)`,
				m.Name, sum, Millis(db.clock.Now()))
			return err
		})
		if err != nil {
			return res, fmt.Errorf("migration %s: %w", m.Name, err)
		}
		applied[m.Name] = sum
		res.Applied = append(res.Applied, m.Name)
	}
	res.Total = len(applied)
	return res, nil
}

// checksum ignores carriage returns so a CRLF checkout does not look edited.
func checksum(s string) string {
	h := sha256.Sum256([]byte(strings.ReplaceAll(s, "\r", "")))
	return hex.EncodeToString(h[:])
}
