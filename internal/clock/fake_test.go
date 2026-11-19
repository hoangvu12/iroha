package clock_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func fired(ch <-chan time.Time) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestFakeTimerFiresOnlyWhenAdvancedPastDeadline(t *testing.T) {
	c := clock.NewFake(t0)
	tm := c.NewTimer(time.Minute)
	c.Advance(59 * time.Second)
	if fired(tm.C()) {
		t.Fatal("fired early")
	}
	c.Advance(time.Second)
	if !fired(tm.C()) {
		t.Fatal("did not fire at deadline")
	}
	if c.Waiters() != 0 {
		t.Fatalf("waiters = %d after firing", c.Waiters())
	}
}

func TestFakeTimerStopAndReset(t *testing.T) {
	c := clock.NewFake(t0)
	tm := c.NewTimer(time.Minute)
	if !tm.Stop() {
		t.Fatal("Stop of a pending timer returned false")
	}
	c.Advance(time.Hour)
	if fired(tm.C()) {
		t.Fatal("stopped timer fired")
	}
	tm.Reset(time.Second)
	c.Advance(time.Second)
	if !fired(tm.C()) {
		t.Fatal("reset timer did not fire")
	}
}

func TestFakeTickerFiresEveryPeriod(t *testing.T) {
	c := clock.NewFake(t0)
	tk := c.NewTicker(time.Hour)
	defer tk.Stop()
	for i := 1; i <= 3; i++ {
		c.Advance(time.Hour)
		select {
		case at := <-tk.C():
			if want := t0.Add(time.Duration(i) * time.Hour); !at.Equal(want) {
				t.Fatalf("tick %d at %v, want %v", i, at, want)
			}
		default:
			t.Fatalf("tick %d missing", i)
		}
	}
}

func TestWithTimeoutUsesTheClock(t *testing.T) {
	c := clock.NewFake(t0)
	ctx, cancel := clock.WithTimeout(context.Background(), c, 60*time.Second)
	defer cancel()
	if dl, _ := ctx.Deadline(); !dl.Equal(t0.Add(60 * time.Second)) {
		t.Fatalf("deadline = %v", dl)
	}
	if err := c.BlockUntil(ctx, 1); err != nil {
		t.Fatal(err)
	}
	c.Advance(60 * time.Second)
	select {
	case <-ctx.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("context not done after the fake deadline")
	}
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("err = %v", ctx.Err())
	}
}

func TestSleepWakesOnAdvance(t *testing.T) {
	c := clock.NewFake(t0)
	done := make(chan error)
	go func() { done <- clock.Sleep(context.Background(), c, time.Minute) }()
	if err := c.BlockUntil(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	c.Advance(time.Minute)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
