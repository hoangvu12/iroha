package rules

import "testing"

func TestOutcomeWords(t *testing.T) {
	for _, c := range []struct {
		o           Outcome
		cool, model string
		key, req    string
	}{
		{Invalid, "", "", "Mark invalid", "Try next key"},
		{ModelGap, "", "", "Record Model Gap for the model", "Try next key"},
		{ModelGap, "", "gpt-x", "Record Model Gap for gpt-x", "Try next key"},
		{CoolingKey, "15 min", "gpt-x", "Cool 15 min", "Try next key"},
		{CoolingKeyModel, "until reset", "", "Cool until reset for the model", "Try next key"},
		{CoolingKeyModel, "30 s", "gpt-x", "Cool 30 s for gpt-x", "Try next key"},
		{RetryElsewhere, "", "", "No change", "Try next key"},
		{FailRequest, "", "", "No change", "Return to Caller"},
	} {
		if got := KeyEffect(c.o, c.cool, c.model); got != c.key {
			t.Errorf("KeyEffect(%s, %q, %q) = %q, want %q", c.o, c.cool, c.model, got, c.key)
		}
		if got := c.o.RequestEffect(); got != c.req {
			t.Errorf("%s.RequestEffect() = %q, want %q", c.o, got, c.req)
		}
	}
}

func TestSecondsInWords(t *testing.T) {
	for n, want := range map[int]string{
		1: "1 s", 60: "60 s", 119: "119 s", 120: "2 min", 150: "2 min 30 s", 900: "15 min",
		3600: "1 h", 5400: "1 h 30 min", 7200: "2 h", 86400: "24 h",
	} {
		if got := Seconds(n); got != want {
			t.Errorf("Seconds(%d) = %q, want %q", n, got, want)
		}
	}
}
