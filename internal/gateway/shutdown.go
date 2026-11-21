package gateway

import (
	"context"
	"errors"
	"sync"
)

var ErrShuttingDown = errors.New("Iroha is shutting down")

type inflight struct {
	mu       sync.Mutex
	stops    map[*exchange]context.CancelCauseFunc
	aborting bool
	wg       sync.WaitGroup
}

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
