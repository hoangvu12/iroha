// Package hosts reads the host of a URL the one way Iroha compares hosts:
// Failure Rules and normalisers limited to a service, and the logs naming
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
