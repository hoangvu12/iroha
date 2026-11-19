// Package store opens Iroha's single SQLite file and applies its migrations.
// Feature packages own their own queries; they receive a *DB and use the
// embedded *sql.DB directly. Times are stored as INTEGER unix milliseconds
// (UTC); use Millis and FromMillis to convert.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"

	_ "modernc.org/sqlite" // registers the pure-Go "sqlite" driver
)

// FileName is the database file inside the data directory.
const FileName = "iroha.db"

// DB is the open database. Writes should go through Tx so they take the
// write lock up front instead of failing on a lock upgrade.
type DB struct {
	*sql.DB
	Path  string
	clock clock.Clock
}

// Open opens (creating if needed) the SQLite file at path with WAL, a busy
// timeout and foreign keys on. It does not migrate; call Migrate.
func Open(ctx context.Context, path string, c clock.Clock) (*DB, error) {
	q := url.Values{}
	for _, p := range []string{"busy_timeout(10000)", "journal_mode(WAL)", "foreign_keys(1)", "synchronous(NORMAL)"} {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", "immediate")
	dsn := "file:" + filepathToURI(path) + "?" + q.Encode()
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return &DB{DB: sqlDB, Path: path, clock: c}, nil
}

// Clock returns the clock the store was opened with.
func (db *DB) Clock() clock.Clock { return db.clock }

// Tx runs fn in a write transaction, committing when fn returns nil.
func (db *DB) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
			return errors.Join(err, rbErr)
		}
		return err
	}
	return tx.Commit()
}

// TouchEvery limits "last used" writes to one per record per minute.
const TouchEvery = time.Minute

// Touch is the throttled "last used" write: it sets the time column of row
// id in table to now, unless the stored time is less than every old. last
// is the stored time when the caller already read it (nil: unknown), so a
// recent use costs no write at all. table and column are Iroha's own
// constants, never input.
func (db *DB) Touch(ctx context.Context, table, column, id string, last *time.Time, now time.Time, every time.Duration) error {
	if last != nil && !last.IsZero() && now.Sub(*last) < every {
		return nil
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE `+table+` SET `+column+` = ? WHERE id = ? AND (`+column+` IS NULL OR `+column+` <= ?)`,
			Millis(now), id, Millis(now.Add(-every)))
		return err
	})
}

// Millis converts t to the stored form. The zero time becomes 0.
func Millis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// FromMillis converts a stored time back. 0 becomes the zero time.
func FromMillis(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

// NullMillis converts a nullable stored time. NULL becomes the zero time.
func NullMillis(v sql.NullInt64) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	return FromMillis(v.Int64)
}

// filepathToURI turns a Windows or Unix path into the path part of a file: URI.
func filepathToURI(p string) string {
	u := url.URL{Path: toSlash(p)}
	return u.EscapedPath()
}

func toSlash(p string) string {
	b := []byte(p)
	for i, c := range b {
		if c == '\\' {
			b[i] = '/'
		}
	}
	return string(b)
}
