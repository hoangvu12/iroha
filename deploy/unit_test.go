// Package deploy holds the deploy script, the server half it runs over SSH
// and the systemd unit. Its tests check the unit against Iroha's startup
// configuration; deploy/test/e2e.sh exercises the scripts against a local
// container.
package deploy_test

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/config"
)

// unit reads iroha.service with example values for its placeholders and
// returns each [Service] key's values in order.
func unit(t *testing.T) map[string][]string {
	t.Helper()
	raw, err := os.ReadFile("iroha.service")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.NewReplacer("@DIR@", "/opt/iroha", "@ADDR@", "127.0.0.1:8080", "@RUN_AS@", "iroha").Replace(string(raw))
	keys := map[string][]string{}
	section := ""
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.Contains(line, "@") {
			t.Fatalf("unit line %q has a placeholder deploy.sh does not render", line)
		}
		if strings.HasPrefix(line, "[") {
			section = line
			continue
		}
		if section != "[Service]" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("bad unit line %q", line)
		}
		keys[k] = append(keys[k], v)
	}
	return keys
}

func one(t *testing.T, u map[string][]string, key string) string {
	t.Helper()
	if len(u[key]) != 1 {
		t.Fatalf("unit has %d %s= lines, want 1", len(u[key]), key)
	}
	return u[key][0]
}

// The drain limit Iroha actually uses under this unit: ExecStart's flags and
// Environment= variables read by the real config parser.
func drainUnderUnit(t *testing.T, u map[string][]string) time.Duration {
	t.Helper()
	env := map[string]string{}
	for _, e := range u["Environment"] {
		k, v, _ := strings.Cut(strings.Trim(e, `"`), "=")
		env[k] = v
	}
	args := strings.Fields(one(t, u, "ExecStart"))
	if args[0] != "/opt/iroha/iroha" {
		t.Fatalf("ExecStart runs %q, want the binary in the install directory", args[0])
	}
	cfg, err := config.Parse(args[1:], func(k string) string { return env[k] }, io.Discard)
	if err != nil {
		t.Fatalf("Iroha would refuse the unit's ExecStart: %v", err)
	}
	if cfg.DataDir != "/opt/iroha" {
		t.Fatalf("data dir %q, want the install directory (backups copy iroha.db from there)", cfg.DataDir)
	}
	return cfg.DrainTimeout
}

func TestUnitStopTimeoutCoversTheDrainLimit(t *testing.T) {
	u := unit(t)
	drain := drainUnderUnit(t, u)
	stop, err := time.ParseDuration(one(t, u, "TimeoutStopSec"))
	if err != nil {
		t.Fatalf("TimeoutStopSec: %v (write it with a unit, e.g. 40s)", err)
	}
	// systemd SIGKILLs after TimeoutStopSec; the drain plus closing the
	// database must fit inside it, and the margin should stay small so a
	// stuck process does not hold a deploy for long.
	if stop < drain+5*time.Second || stop > drain+30*time.Second {
		t.Fatalf("TimeoutStopSec %v does not match the drain limit %v (want drain + 5s..30s)", stop, drain)
	}
	if got := one(t, u, "KillSignal"); got != "SIGTERM" {
		t.Fatalf("KillSignal %s; Iroha drains on SIGTERM", got)
	}
	// mixed: SIGTERM to Iroha alone, SIGKILL to everything at the timeout.
	if got := one(t, u, "KillMode"); got != "mixed" && got != "control-group" {
		t.Fatalf("KillMode %s", got)
	}
}

// The runbook in the served skill must describe this script and unit.
func TestRunbookMatchesScriptAndUnit(t *testing.T) {
	runbook, err := os.ReadFile("../internal/api/skill/50_deploy.md")
	if err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile("deploy.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(runbook), "\n") {
		if !strings.Contains(line, "deploy.sh") {
			continue // other commands' flags, e.g. useradd's
		}
		for _, opt := range regexp.MustCompile(`(?:^|[\s(\x60])(--[a-z][a-z-]+)`).FindAllStringSubmatch(line, -1) {
			listed := regexp.MustCompile(`(?m)^\s+(?:-\w, )?` + regexp.QuoteMeta(opt[1]) + `\b`)
			if !listed.Match(script) {
				t.Errorf("runbook mentions %s, which deploy.sh --help does not list", opt[1])
			}
		}
	}
	for _, outcome := range []string{"10) ", "11) ", "IROHA_DEPLOY"} {
		if !strings.Contains(string(script), outcome) {
			t.Errorf("deploy.sh no longer handles %q, which the runbook describes", outcome)
		}
	}
	u := unit(t)
	stop, _ := time.ParseDuration(one(t, u, "TimeoutStopSec"))
	for _, d := range []time.Duration{drainUnderUnit(t, u), stop} {
		if want := fmt.Sprintf("%d s", int(d.Seconds())); !strings.Contains(string(runbook), want) {
			t.Errorf("runbook does not state the unit's %s", want)
		}
	}
}

func TestUnitRestartsOnlyOnFailureAndWritesOnlyTheInstallDirectory(t *testing.T) {
	u := unit(t)
	if got := one(t, u, "Restart"); got != "on-failure" {
		t.Fatalf("Restart=%s; a deploy's stop must not be undone by systemd", got)
	}
	if one(t, u, "ProtectSystem") != "strict" || one(t, u, "ReadWritePaths") != "/opt/iroha" {
		t.Fatal("the service should write only its install directory")
	}
	if one(t, u, "User") == "root" {
		t.Fatal("the service must not run as root")
	}
}
