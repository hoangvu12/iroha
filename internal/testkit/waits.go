package testkit

import (
	"context"
	"time"
)

func (s *Server) SkipShortWaits(max time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.t.Cleanup(func() { cancel(); <-done })
	c := s.Clock
	go func() {
		defer close(done)
		for c.BlockUntilDueWithin(ctx, max) == nil {
			if at, ok := c.Next(); ok && !at.After(c.Now().Add(max)) {
				c.Set(at)
			}
		}
	}()
}
