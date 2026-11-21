package clock

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Fake is a Clock that only moves when told to. Timers and tickers fire
// during Advance or Set, in deadline order. It is safe for concurrent use.
type Fake struct {
	mu      sync.Mutex
	now     time.Time
	waiters []*fakeWaiter
	changed broadcast
}

type broadcast struct{ ch chan struct{} }

func newBroadcast() broadcast { return broadcast{ch: make(chan struct{})} }

func (b *broadcast) next() <-chan struct{} { return b.ch }

func (b *broadcast) notify() {
	close(b.ch)
	b.ch = make(chan struct{})
}

func NewFake(start time.Time) *Fake {
	return &Fake{now: start, changed: newBroadcast()}
}

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Advance moves the clock forward by d, firing everything due on the way.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	target := f.now.Add(d)
	f.mu.Unlock()
	f.Set(target)
}

// Set moves the clock to t (never backwards), firing everything due on the way.
func (f *Fake) Set(t time.Time) {
	for {
		f.mu.Lock()
		if t.Before(f.now) {
			f.mu.Unlock()
			return
		}
		sort.SliceStable(f.waiters, func(i, j int) bool { return f.waiters[i].at.Before(f.waiters[j].at) })
		if len(f.waiters) == 0 || f.waiters[0].at.After(t) {
			f.now = t
			f.changed.notify()
			f.mu.Unlock()
			return
		}
		w := f.waiters[0]
		if w.at.After(f.now) {
			f.now = w.at
		}
		if w.period > 0 {
			w.at = w.at.Add(w.period)
		} else {
			f.waiters = f.waiters[1:]
		}
		f.changed.notify()
		now := f.now
		f.mu.Unlock()
		w.fire(now)
	}
}

// Waiters reports how many timers and tickers are pending.
func (f *Fake) Waiters() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.waiters)
}

// BlockUntil waits until at least n timers or tickers are pending, so a test
// can be sure the code under test is waiting before it calls Advance.
func (f *Fake) BlockUntil(ctx context.Context, n int) error {
	return f.blockUntil(ctx, func() bool { return len(f.waiters) >= n })
}

// Next reports when the earliest pending timer or ticker fires; ok is false
// when none is pending.
func (f *Fake) Next() (at time.Time, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, w := range f.waiters {
		if !ok || w.at.Before(at) {
			at, ok = w.at, true
		}
	}
	return at, ok
}

// BlockUntilDue waits until a timer or ticker is pending that fires at or
// before t. Use it when code under test re-arms a timer after one fired,
// before the next Advance: a count of waiters cannot tell a re-armed timer
// from others coming and going.
func (f *Fake) BlockUntilDue(ctx context.Context, t time.Time) error {
	return f.blockUntil(ctx, func() bool { return f.dueByLocked(t) })
}

// BlockUntilDueWithin waits until a timer or ticker is pending that fires
// within d of the current time, re-checking whenever the clock moves.
func (f *Fake) BlockUntilDueWithin(ctx context.Context, d time.Duration) error {
	return f.blockUntil(ctx, func() bool { return f.dueByLocked(f.now.Add(d)) })
}

func (f *Fake) dueByLocked(t time.Time) bool {
	for _, w := range f.waiters {
		if !w.at.After(t) {
			return true
		}
	}
	return false
}

func (f *Fake) blockUntil(ctx context.Context, holdsLocked func() bool) error {
	for {
		f.mu.Lock()
		if holdsLocked() {
			f.mu.Unlock()
			return nil
		}
		ch := f.changed.next()
		f.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (f *Fake) NewTimer(d time.Duration) Timer {
	return f.start(&fakeWaiter{clock: f, ch: make(chan time.Time, 1)}, d)
}

// AfterFunc calls fn in the goroutine that moves the clock past d, before
// Advance or Set returns, so whatever fn records is visible to the test at
// once. fn must not block or move the clock.
func (f *Fake) AfterFunc(d time.Duration, fn func()) Timer {
	return f.start(&fakeWaiter{clock: f, fn: fn}, d)
}

func (f *Fake) start(w *fakeWaiter, d time.Duration) Timer {
	f.mu.Lock()
	w.at = f.now.Add(d)
	now := f.now
	f.mu.Unlock()
	if d <= 0 {
		w.fire(now)
		return w
	}
	f.add(w)
	return w
}

func (f *Fake) NewTicker(d time.Duration) Ticker {
	if d <= 0 {
		panic("clock: non-positive interval for NewTicker")
	}
	w := &fakeWaiter{clock: f, ch: make(chan time.Time, 1), period: d}
	f.mu.Lock()
	w.at = f.now.Add(d)
	f.mu.Unlock()
	f.add(w)
	return fakeTicker{w}
}

type fakeTicker struct{ w *fakeWaiter }

func (t fakeTicker) C() <-chan time.Time { return t.w.ch }
func (t fakeTicker) Stop()               { t.w.Stop() }

func (f *Fake) add(w *fakeWaiter) {
	f.mu.Lock()
	f.waiters = append(f.waiters, w)
	f.changed.notify()
	f.mu.Unlock()
}

func (f *Fake) remove(w *fakeWaiter) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, x := range f.waiters {
		if x == w {
			f.waiters = append(f.waiters[:i], f.waiters[i+1:]...)
			f.changed.notify()
			return true
		}
	}
	return false
}

type fakeWaiter struct {
	clock  *Fake
	at     time.Time
	period time.Duration
	ch     chan time.Time
	fn     func()
}

func (w *fakeWaiter) fire(now time.Time) {
	if w.fn != nil {
		w.fn()
		return
	}
	select {
	case w.ch <- now:
	default: // like time.Ticker, drop ticks nobody is reading
	}
}

func (w *fakeWaiter) C() <-chan time.Time { return w.ch }

func (w *fakeWaiter) Stop() bool { return w.clock.remove(w) }

func (w *fakeWaiter) Reset(d time.Duration) bool {
	pending := w.clock.remove(w)
	select { // drain a stale fire, matching Go 1.23+ timer semantics
	case <-w.ch:
	default:
	}
	w.clock.start(w, d)
	return pending
}
