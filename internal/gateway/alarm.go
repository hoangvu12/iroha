package gateway

import (
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
)

type alarm struct {
	timer    clock.Timer
	quit     chan struct{}
	done     chan struct{}
	stopOnce sync.Once
}

func newAlarm(c clock.Clock, d time.Duration, ring func()) *alarm {
	a := &alarm{timer: c.NewTimer(d), quit: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(a.done)
		defer a.timer.Stop()
		for {
			select {
			case <-a.quit:
				return
			case <-a.timer.C():
				ring()
			}
		}
	}()
	return a
}

func (a *alarm) reset(d time.Duration) { a.timer.Reset(d) }

func (a *alarm) stop() {
	a.stopOnce.Do(func() { close(a.quit) })
	<-a.done
}
