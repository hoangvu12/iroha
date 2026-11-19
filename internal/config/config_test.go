package config_test

import (
	"io"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/config"
)

func TestModelsDevBaseURLs(t *testing.T) {
	env := func(v string) func(string) string {
		return func(name string) string {
			if name == "IROHA_MODELS_DEV" {
				return v
			}
			return ""
		}
	}
	cases := []struct {
		args []string
		env  string
		want string
		err  bool
	}{
		{nil, "", config.DefaultModelsDev, false},
		{[]string{"--models-dev", "none"}, "", "", false},
		{nil, "http://127.0.0.1:9/, https://mirror.example/x", "http://127.0.0.1:9/,https://mirror.example/x", false},
		{[]string{"--models-dev", "ftp://x"}, "", "", true},
	}
	for _, c := range cases {
		cfg, err := config.Parse(append([]string{"--data-dir", t.TempDir()}, c.args...), env(c.env), io.Discard)
		if (err != nil) != c.err {
			t.Fatalf("Parse(%v, env %q) error = %v", c.args, c.env, err)
		}
		if got := strings.Join(cfg.ModelsDev, ","); !c.err && got != c.want {
			t.Errorf("Parse(%v, env %q).ModelsDev = %q, want %q", c.args, c.env, got, c.want)
		}
	}
}

// CFG-03: every bad startup value is reported in one go, flags and
// environment alike, so one restart fixes them all.
func TestEveryBadStartupValueIsReportedTogether(t *testing.T) {
	env := func(name string) string {
		if name == "IROHA_DRAIN_TIMEOUT" {
			return "soon"
		}
		return ""
	}
	_, err := config.Parse([]string{"--data-dir", t.TempDir(), "--log-level", "loud", "--log-format", "xml", "--models-dev", "ftp://x"}, env, io.Discard)
	if err == nil {
		t.Fatal("Parse accepted bad values")
	}
	for _, want := range []string{`log-level: unknown level "loud"`, `log-format: want json or text, got "xml"`, `drain-timeout: "soon"`, `models-dev: "ftp://x"`} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q:\n%v", want, err)
		}
	}
	if _, err := config.Parse([]string{"--data-dir", t.TempDir(), "--log-level", "warn"}, func(string) string { return "" }, io.Discard); err != nil {
		t.Fatalf("good values: %v", err)
	}
}
