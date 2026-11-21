package rules

import "fmt"

// KeyEffect words what outcome o does to the Upstream Key. cool is how long
// a key cools, in words ("60 s", "until reset"); unused for other outcomes.
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

func (o Outcome) RequestEffect() string {
	if o.Retries() {
		return "Try next key"
	}
	return "Return to Caller"
}

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
