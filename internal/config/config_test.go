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
