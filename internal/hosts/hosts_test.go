package hosts_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/hosts"
)

func TestOf(t *testing.T) {
	for raw, want := range map[string]string{
		"https://DashScope-Intl.Aliyuncs.com/compatible-mode/v1": "dashscope-intl.aliyuncs.com",
		"http://127.0.0.1:8080/v1":                               "127.0.0.1",
		"https://[::1]:443/v1":                                   "::1",
		"::not a url":                                            "",
	} {
		if got := hosts.Of(raw); got != want {
			t.Errorf("Of(%q) = %q, want %q", raw, got, want)
		}
	}
}
