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

func TestMatches(t *testing.T) {
	for _, tc := range []struct {
		host    string
		domains []string
		want    bool
	}{
		{"api.deepseek.com", []string{"deepseek.com"}, true},
		{"deepseek.com", []string{"deepseek.com"}, true},
		{"API.DeepSeek.com", []string{"deepseek.com"}, true},
		{"api.deepseek.com", []string{"DeepSeek.com"}, true},
		{"notdeepseek.com", []string{"deepseek.com"}, false},
		{"deepseek.com.evil.example", []string{"deepseek.com"}, false},
		{"api.mistral.ai", []string{"googleapis.com", "mistral.ai"}, true},
		{"", []string{"deepseek.com"}, false},
		{"api.deepseek.com", nil, false},
	} {
		if got := hosts.Matches(tc.host, tc.domains...); got != tc.want {
			t.Errorf("Matches(%q, %v) = %v", tc.host, tc.domains, got)
		}
	}
}

func TestList(t *testing.T) {
	got := hosts.List(" Relay.Example.com., ,api.x.ai ")
	if len(got) != 2 || got[0] != "relay.example.com" || got[1] != "api.x.ai" {
		t.Errorf("List = %q", got)
	}
}
