package rules

import "fmt"

// The words for what an outcome does, shared by the rules list
// (failurerules) and Try a failure (gateway classify), so the two never say
// it differently. The UI shows them as the server sends them.

// KeyEffect words what outcome o does to the Upstream Key: Mark invalid,
// Record Model Gap, Cool <cool>, No change. Per-model outcomes add "for
// <model>", or "for the model" when model is empty. cool is how long a key
// cools, in words ("60 s", "until reset"); unused for other outcomes.
func KeyEffect(o Outcome, cool, model string) string {
	forModel := " for the model"
	if model != "" {
		forModel = " for " + model
	}
	switch o {
	case Invalid:
		return "Mark invalid"
	case ModelGap:
		return "Record Model Gap" + forModel
	case CoolingKey:
		return "Cool " + cool
	case CoolingKeyModel:
		return "Cool " + cool + forModel
	}
	return "No change"
}

// RequestEffect words what outcome o does to the Request.
func (o Outcome) RequestEffect() string {
	if o.Retries() {
		return "Try next key"
	}
	return "Return to Caller"
}

// Seconds is a cooling time in words: 30 s, 2 min, 2 min 30 s, 1 h,
// 1 h 30 min.
func Seconds(n int) string {
	switch {
	case n < 120:
		return fmt.Sprintf("%d s", n)
	case n < 3600 && n%60 == 0:
		return fmt.Sprintf("%d min", n/60)
	case n < 3600:
		return fmt.Sprintf("%d min %d s", n/60, n%60)
	case n%3600 == 0:
		return fmt.Sprintf("%d h", n/3600)
	}
	return fmt.Sprintf("%d h %d min", n/3600, n%3600/60)
}
