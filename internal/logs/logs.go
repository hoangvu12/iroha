package logs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/store"
)

// Options configures a Log.
type Options struct {
	DB      *store.DB // nil: console only
	Clock   clock.Clock
	Console io.Writer // default os.Stdout
	Format  string    // "json" (default) or "text"
	Level   slog.Leveler
}

// Log owns the logger and the background writer into log_events.
// Writes are queued so logging never waits on a query; Flush makes every
// earlier event visible to readers.
type Log struct {
	db     *store.DB
	clock  clock.Clock
	logger *slog.Logger

	mu     sync.RWMutex
	closed bool
	ch     chan item
	done   chan struct{}
}

type item struct {
	row   *row
	flush chan struct{}
}

type row struct {
	at        time.Time
	level     slog.Level
	kind      string
	message   string
	requestID string
	provider  string
	attrs     map[string]any
}

// New starts a Log. Call Close at shutdown.
func New(o Options) *Log {
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Console == nil {
		o.Console = os.Stdout
	}
	if o.Level == nil {
		o.Level = slog.LevelInfo
	}
	hopts := &slog.HandlerOptions{Level: o.Level}
	var console slog.Handler
	if o.Format == "text" {
		console = slog.NewTextHandler(o.Console, hopts)
	} else {
		console = slog.NewJSONHandler(o.Console, hopts)
	}
	l := &Log{db: o.DB, clock: o.Clock, ch: make(chan item, 4096), done: make(chan struct{})}
	l.logger = slog.New(&handler{log: l, console: console, level: o.Level})
	go l.run()
	return l
}

// Logger returns the logger to pass to every component.
func (l *Log) Logger() *slog.Logger { return l.logger }

// Flush waits until every event logged before the call is stored.
func (l *Log) Flush(ctx context.Context) error {
	done := make(chan struct{})
	if !l.enqueue(item{flush: done}) {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stores every queued event and stops the writer. Later events go to
// the console only.
func (l *Log) Close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	close(l.ch)
	l.mu.Unlock()
	<-l.done
}

func (l *Log) enqueue(it item) bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.closed {
		return false
	}
	l.ch <- it
	return true
}

func (l *Log) run() {
	defer close(l.done)
	for it := range l.ch {
		batch := []item{it}
	drain:
		for len(batch) < 512 {
			select {
			case next, ok := <-l.ch:
				if !ok {
					break drain
				}
				batch = append(batch, next)
			default:
				break drain
			}
		}
		l.write(batch)
	}
}

func (l *Log) write(batch []item) {
	var rows []*row
	for _, it := range batch {
		if it.row != nil {
			rows = append(rows, it.row)
		}
	}
	if len(rows) > 0 && l.db != nil {
		err := l.db.Tx(context.Background(), func(tx *sql.Tx) error {
			stmt, err := tx.Prepare(`INSERT INTO log_events (at, level, kind, message, request_id, provider, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			if err != nil {
				return err
			}
			defer stmt.Close()
			for _, r := range rows {
				attrs, err := json.Marshal(r.attrs)
				if err != nil {
					attrs = []byte(fmt.Sprintf(`{"marshal_error":%q}`, err.Error()))
				}
				if _, err := stmt.Exec(store.Millis(r.at), int(r.level), r.kind, r.message, nullable(r.requestID), nullable(r.provider), string(attrs)); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			// The store is failing; the console is the only place left to say so.
			fmt.Fprintf(os.Stderr, "iroha: storing %d log events failed: %v\n", len(rows), err)
		}
	}
	for _, it := range batch {
		if it.flush != nil {
			close(it.flush)
		}
	}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// handler implements slog.Handler, teeing to the console handler and the
// store queue. The record time always comes from the injected clock.
type handler struct {
	log     *Log
	console slog.Handler
	level   slog.Leveler
	preset  []field
	prefix  string
}

type field struct {
	key string
	val slog.Value
	top bool // added outside any group
}

func (h *handler) Enabled(_ context.Context, lvl slog.Level) bool {
	return lvl >= h.level.Level()
}

func (h *handler) Handle(ctx context.Context, r slog.Record) error {
	r.Time = h.log.clock.Now()
	err := h.console.Handle(ctx, r)

	rw := &row{at: r.Time, level: r.Level, message: r.Message, kind: DefaultKind, attrs: map[string]any{}}
	put := func(f field) {
		if f.top {
			switch f.key {
			case KindKey:
				rw.kind = f.val.String()
				return
			case RequestKey:
				rw.requestID = f.val.String()
				return
			case ProviderKey:
				rw.provider = f.val.String()
				return
			}
		}
		rw.attrs[f.key] = jsonValue(f.val)
	}
	for _, f := range h.preset {
		put(f)
	}
	r.Attrs(func(a slog.Attr) bool {
		for _, f := range flatten(h.prefix, a) {
			put(f)
		}
		return true
	})
	h.log.enqueue(item{row: rw})
	return err
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	c := *h
	c.console = h.console.WithAttrs(attrs)
	c.preset = append([]field(nil), h.preset...)
	for _, a := range attrs {
		c.preset = append(c.preset, flatten(h.prefix, a)...)
	}
	return &c
}

func (h *handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	c := *h
	c.console = h.console.WithGroup(name)
	c.prefix = h.prefix + name + "."
	return &c
}

func flatten(prefix string, a slog.Attr) []field {
	v := a.Value.Resolve()
	if v.Kind() == slog.KindGroup {
		p := prefix
		if a.Key != "" {
			p = prefix + a.Key + "."
		}
		var out []field
		for _, g := range v.Group() {
			out = append(out, flatten(p, g)...)
		}
		return out
	}
	if a.Key == "" {
		return nil
	}
	return []field{{key: prefix + a.Key, val: v, top: prefix == ""}}
}

func jsonValue(v slog.Value) any {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindInt64:
		return v.Int64()
	case slog.KindUint64:
		return v.Uint64()
	case slog.KindFloat64:
		return v.Float64()
	case slog.KindBool:
		return v.Bool()
	case slog.KindDuration:
		return v.Duration().String()
	case slog.KindTime:
		return v.Time().UTC().Format(time.RFC3339Nano)
	}
	a := v.Any()
	if err, ok := a.(error); ok {
		return err.Error()
	}
	if _, ok := a.(json.Marshaler); ok {
		return a
	}
	if s, ok := a.(fmt.Stringer); ok {
		return s.String()
	}
	if b, err := json.Marshal(a); err == nil {
		return json.RawMessage(b)
	}
	return fmt.Sprint(a)
}
