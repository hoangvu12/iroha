// Package clock is the only source of time in Iroha. Production code takes a
// Clock instead of calling time.Now, time.After, time.NewTimer or
// context.WithTimeout directly, so tests can drive cooling, Model Gap expiry,
// budgets and jobs with a Fake clock instead of sleeping.
package clock

import (
	"context"
	"time"
)

// Clock tells the time and makes timers.
type Clock interface {
	Now() time.Time
	// NewTimer fires once after d.
	NewTimer(d time.Duration) Timer
	// NewTicker fires every d until stopped.
	NewTicker(d time.Duration) Ticker
}

// Timer mirrors time.Timer behind an interface.
type Timer interface {
	C() <-chan time.Time
	// Stop prevents the timer from firing; it reports whether it was pending.
	Stop() bool
	// Reset re-arms the timer to fire after d; it reports whether it was pending.
	Reset(d time.Duration) bool
}

// Ticker mirrors time.Ticker behind an interface.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// Since is c.Now().Sub(t).
func Since(c Clock, t time.Time) time.Duration { return c.Now().Sub(t) }

// After returns a channel that receives the time once d has passed on c.
// The underlying timer is not stopped early; prefer NewTimer in loops.
func After(c Clock, d time.Duration) <-chan time.Time { return c.NewTimer(d).C() }

// Sleep waits for d on c or until ctx is done, returning ctx's error in that case.
func Sleep(ctx context.Context, c Clock, d time.Duration) error {
	t := c.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// WithTimeout is context.WithTimeout measured on c. When the time runs out the
// context's Err is context.DeadlineExceeded, exactly as with the standard one.
func WithTimeout(parent context.Context, c Clock, d time.Duration) (context.Context, context.CancelFunc) {
	if _, ok := c.(Real); ok {
		return context.WithTimeout(parent, d)
	}
	deadline := c.Now().Add(d)
	inner, cancel := context.WithCancelCause(parent)
	ctx := &timeoutCtx{Context: inner, deadline: deadline}
	t := c.NewTimer(d)
	go func() {
		select {
		case <-t.C():
			cancel(context.DeadlineExceeded)
		case <-inner.Done():
			t.Stop()
		}
	}()
	return ctx, func() { cancel(context.Canceled) }
}

type timeoutCtx struct {
	context.Context
	deadline time.Time
}

func (c *timeoutCtx) Deadline() (time.Time, bool) {
	if d, ok := c.Context.Deadline(); ok && d.Before(c.deadline) {
		return d, true
	}
	return c.deadline, true
}

func (c *timeoutCtx) Err() error {
	err := c.Context.Err()
	if err == nil {
		return nil
	}
	if context.Cause(c.Context) == context.DeadlineExceeded {
		return context.DeadlineExceeded
	}
	return err
}

// Real is the wall clock.
type Real struct{}

func (Real) Now() time.Time                   { return time.Now() }
func (Real) NewTimer(d time.Duration) Timer   { return realTimer{time.NewTimer(d)} }
func (Real) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time        { return r.t.C }
func (r realTimer) Stop() bool                 { return r.t.Stop() }
func (r realTimer) Reset(d time.Duration) bool { return r.t.Reset(d) }

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }
