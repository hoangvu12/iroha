package session

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/hoangvu12/iroha/internal/api"
)

const (
	MinPasswordLength = 8
	MaxPasswordLength = 1024
)

// pbkdf2Iterations follows OWASP's 2023 advice for PBKDF2-HMAC-SHA256. The
// count is stored in each hash, so raising it later keeps old hashes valid.
const pbkdf2Iterations = 600_000

const hashScheme = "pbkdf2-sha256"

func checkPassword(field, p string) error {
	n := utf8.RuneCountInString(p)
	if n < MinPasswordLength {
		return api.BadRequest(fmt.Sprintf("Choose a password of at least %d characters.", MinPasswordLength),
			"%s is too short (%d characters).", field, n)
	}
	if len(p) > MaxPasswordLength {
		return api.BadRequest(fmt.Sprintf("Choose a password of at most %d bytes.", MaxPasswordLength), "%s is too long.", field)
	}
	return nil
}

func hashPassword(p string) (string, error) {
	salt := make([]byte, 16)
	_, _ = rand.Read(salt)
	key, err := pbkdf2.Key(sha256.New, p, salt, pbkdf2Iterations, 32)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("%s$%d$%s$%s", hashScheme, pbkdf2Iterations, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func verifyPassword(hash, p string) (bool, error) {
	parts := strings.Split(hash, "$")
	if len(parts) != 4 || parts[0] != hashScheme {
		return false, fmt.Errorf("session: unknown password hash format")
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false, fmt.Errorf("session: bad iteration count in password hash")
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[2])
	want, err2 := enc.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false, fmt.Errorf("session: password hash does not decode")
	}
	got, err := pbkdf2.Key(sha256.New, p, salt, iter, len(want))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func secretHash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
