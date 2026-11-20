// Package hosts reads the host of a URL and matches it against domains the
// one way Iroha compares hosts: Failure Rules and normalisers limited to a
// service, the prompt caching defaults per Provider, and the logs naming
// where a call went.
package hosts

import (
	"net/url"
	"strings"
)

// Of is the lowercased host name of raw, without port; "" when raw does
// not parse.
func Of(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// Matches reports whether host is one of domains or a subdomain of one,
// ignoring case: "api.deepseek.com" matches "deepseek.com",
// "notdeepseek.com" does not.
func Matches(host string, domains ...string) bool {
	host = strings.ToLower(host)
	if host == "" {
		return false
	}
	for _, d := range domains {
		d = strings.ToLower(d)
		if d != "" && (host == d || strings.HasSuffix(host, "."+d)) {
			return true
		}
	}
	return false
}

// List splits a comma-separated list of domains (a Failure Rule's or a
// normaliser's host), lowercased, without spaces, empty items or a
// trailing dot.
func List(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		if h = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(h), ".")); h != "" {
			out = append(out, h)
		}
	}
	return out
}
