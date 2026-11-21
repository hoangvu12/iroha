package modelrefresh

import (
	"fmt"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/models"
)

func TestDailyTimesAreStableAndSpreadAcrossTheDay(t *testing.T) {
	if DailyAt("pr_abc") != DailyAt("pr_abc") {
		t.Fatal("DailyAt is not stable")
	}
	perHour := make([]int, 24)
	const n = 2400
	for i := range n {
		at := DailyAt(fmt.Sprintf("pr_%06d", i))
		if at < 0 || at >= day || at%time.Minute != 0 {
			t.Fatalf("DailyAt = %v", at)
		}
		perHour[at/time.Hour]++
	}
	for h, c := range perHour {
		if c < n/24/2 || c > n/24*2 {
			t.Fatalf("hour %d has %d of %d Providers: %v", h, c, n, perHour)
		}
	}
}

func TestNextRefresh(t *testing.T) {
	id := ""
	for i := 0; id == ""; i++ {
		if c := fmt.Sprintf("pr_%d", i); DailyAt(c) == 10*time.Hour+37*time.Minute {
			id = c
		}
	}
	d := func(day, h, m int) time.Time { return time.Date(2026, 1, day, h, m, 0, 0, time.UTC) }
	last := func(at time.Time) *models.LastRefresh { return &models.LastRefresh{At: at, Outcome: "ok"} }

	for _, tc := range []struct {
		name    string
		created time.Time
		last    *models.LastRefresh
		start   time.Time
		want    time.Time
	}{
		{"never refreshed: its minutes within the hour after the start", d(1, 0, 0), nil, d(5, 8, 0), d(5, 8, 37)},
		{"never refreshed, created after the start: within the hour after creation", d(5, 9, 10), nil, d(5, 8, 0), d(5, 9, 47)},
		{"refreshed at its time: the same time next day", d(1, 0, 0), last(d(5, 10, 37)), d(5, 8, 0), d(6, 10, 37)},
		{"refreshed in the first hour: its time next day", d(1, 0, 0), last(d(5, 8, 37)), d(5, 8, 0), d(6, 10, 37)},
		{"refreshed by hand 13 h before its time: that day", d(1, 0, 0), last(d(4, 21, 30)), d(4, 8, 0), d(5, 10, 37)},
		{"refreshed by hand 11 h before its time: the day after", d(1, 0, 0), last(d(4, 23, 40)), d(4, 8, 0), d(6, 10, 37)},
		{"due before the start (Iroha was down): spread after the start", d(1, 0, 0), last(d(2, 10, 37)), d(5, 8, 0), d(5, 8, 37)},
		{"due after a restart: unchanged", d(1, 0, 0), last(d(4, 10, 37)), d(5, 8, 0), d(5, 10, 37)},
	} {
		if got := nextRefresh(id, tc.created, tc.last, tc.start); !got.Equal(tc.want) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
