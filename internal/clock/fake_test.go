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

func TestBlockUntilDueWaitsForATimerAtOrBeforeTheTime(t *testing.T) {
	c := clock.NewFake(t0)
	c.NewTimer(time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.BlockUntilDue(ctx, t0.Add(time.Minute)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("with only a later timer: %v", err)
	}
	re := c.NewTimer(time.Second)
	go func() {
		<-re.C()
		re.Reset(time.Minute)
	}()
	c.Advance(time.Second)
	if err := c.BlockUntilDue(context.Background(), t0.Add(time.Second+time.Minute)); err != nil {
		t.Fatal(err)
	}
	c.Advance(time.Minute)
	select {
	case <-re.C():
	default:
		t.Fatal("the re-armed timer did not fire")
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

func TestFakeAfterFuncRunsDuringAdvance(t *testing.T) {
	c := clock.NewFake(t0)
	ran := 0
	tm := c.AfterFunc(time.Minute, func() { ran++ })
	c.Advance(59 * time.Second)
	if ran != 0 {
		t.Fatal("ran early")
	}
	c.Advance(time.Second)
	if ran != 1 {
		t.Fatalf("ran %d times by the time Advance returned, want 1", ran)
	}
	if tm.Stop() {
		t.Fatal("Stop after firing reported the func as pending")
	}
	stopped := c.AfterFunc(time.Minute, func() { ran++ })
	if !stopped.Stop() {
		t.Fatal("Stop of a pending func returned false")
	}
	c.Advance(time.Hour)
	if ran != 1 {
		t.Fatal("a stopped func ran")
	}
}

func TestBlockUntilDueWithinWakesWhenTheTimeMoves(t *testing.T) {
	c := clock.NewFake(t0)
	c.NewTimer(time.Hour)
	woke := make(chan error, 1)
	go func() { woke <- c.BlockUntilDueWithin(context.Background(), time.Minute) }()
	select {
	case err := <-woke:
		t.Fatalf("returned with only a timer an hour away: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	c.Advance(59*time.Minute + 30*time.Second)
	select {
	case err := <-woke:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("moving the clock to within a minute of the timer woke no one")
	}
}
