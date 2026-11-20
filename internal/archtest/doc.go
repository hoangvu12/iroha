// Package archtest holds no code: its tests turn the rules in
// docs/agents/architecture.md ("Rules everyone follows" and the package map)
// into checks over the module's non-test Go files and migrations. Each
// failure names the file:line, the rule and what to do instead.
package archtest

import "regexp"

var snake = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`)
