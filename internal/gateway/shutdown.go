package gateway

import (
	"context"
	"errors"
	"sync"
)

// ErrShuttingDown is the cause that ends Requests still in flight when
// Iroha's drain limit runs out (Gateway.Abort).
var ErrShuttingDown = errors.New("Iroha is shutting down")

// inflight is the set of Requests being served, so a shutdown can end them
// with an answer instead of cutting their connections.
type inflight struct {
	mu       sync.Mutex
	stops    map[*exchange]context.CancelCauseFunc
	aborting bool
	wg       sync.WaitGroup
}

// track adds x to the Requests in flight, giving it a context Abort can
// end. The returned func removes it; call it when the handler returns.
func (g *Gateway) track(x *exchange) (untrack func()) {
	ctx, stop := context.WithCancelCause(x.ctx)
	x.ctx = ctx
	l := &g.live
	l.mu.Lock()
	if l.stops == nil {
		l.stops = map[*exchange]context.CancelCauseFunc{}
	}
	l.stops[x] = stop
	if l.aborting {
		stop(ErrShuttingDown)
	}
	l.wg.Add(1)
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		delete(l.stops, x)
		l.mu.Unlock()
		stop(context.Canceled)
		l.wg.Done()
	}
}

// Abort ends every Request in flight, and any that arrives later: each
// stops its Attempt, tells its Caller in the Caller's Shape that Iroha is
// shutting down (503 shutting_down, or an error event on a stream under
// way) and is recorded. Abort waits for them to finish until ctx ends and
// returns how many it ended. The server calls it when the drain limit runs
// out, before closing the remaining connections.
func (g *Gateway) Abort(ctx context.Context) int {
	l := &g.live
	l.mu.Lock()
	l.aborting = true
	n := len(l.stops)
	for _, stop := range l.stops {
		stop(ErrShuttingDown)
	}
	l.mu.Unlock()
	done := make(chan struct{})
	go func() { l.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	return n
}
