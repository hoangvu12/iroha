package testkit

import (
	"context"
	"time"
)

// SkipShortWaits lets short waits pass on their own for the rest of the
// test: whenever a timer is due within max of the fake clock's time, the
// clock moves to it. Use it in tests whose Requests replay a 5xx (the
// gateway pauses up to a few hundred milliseconds first) but that are not
// about the pause. Keep max below every wait the test drives itself, such
// as the 10 s stream commit.
func (s *Server) SkipShortWaits(max time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.t.Cleanup(func() { cancel(); <-done })
	c := s.Clock
	go func() {
		defer close(done)
		for {
			// The test may move the clock meanwhile, which wakes no one, so
			// look again every few milliseconds.
			wait, stop := context.WithTimeout(ctx, 5*time.Millisecond)
			err := c.BlockUntilDue(wait, c.Now().Add(max))
			stop()
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				continue
			}
			if at, ok := c.Next(); ok && !at.After(c.Now().Add(max)) {
				c.Set(at)
			}
		}
	}()
}
