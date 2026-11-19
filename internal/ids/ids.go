// Package ids makes record IDs and secrets.
package ids

import (
	"crypto/rand"
	"encoding/base32"
	"strings"
)

var enc = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func random(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never fails
	return enc.EncodeToString(b)
}

// New returns a record ID such as "at_k3x9...": a short type prefix and 16
// random characters. IDs are opaque; order records by their timestamps.
func New(prefix string) string { return prefix + "_" + random(10) }

// Secret returns a secret such as "iroha_admin_..." with 256 bits of randomness.
func Secret(prefix string) string {
	return strings.TrimSuffix(prefix, "_") + "_" + random(32)
}
