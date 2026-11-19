// Package ids makes record IDs and secrets.
package ids

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
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

// UUID returns a random (version 4) UUID, for values other systems read,
// such as the Idempotency-Key Iroha sends upstream.
func UUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Secret returns a secret such as "iroha_admin_..." with 256 bits of randomness.
func Secret(prefix string) string {
	return strings.TrimSuffix(prefix, "_") + "_" + random(32)
}
