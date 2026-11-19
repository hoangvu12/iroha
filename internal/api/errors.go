package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Error is the one error form of the admin API. Every error a handler returns
// reaches the client as {"error": {"code", "message", "hint", "details"}}.
// The hint always names the next action an agent can take.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code" doc:"Stable machine-readable error code."`
	Message string `json:"message" doc:"What went wrong."`
	Hint    string `json:"hint" doc:"What to do next."`
	Details any    `json:"details,omitempty" doc:"Extra structured context, when any."`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// ErrorBody is the JSON envelope of an error response.
type ErrorBody struct {
	Error *Error `json:"error"`
}

// Errorf builds an *Error.
func Errorf(status int, code, hint, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...), Hint: hint}
}

// BadRequest is a 400 with code "invalid_request".
func BadRequest(hint, format string, args ...any) *Error {
	return Errorf(http.StatusBadRequest, "invalid_request", hint, format, args...)
}

// NotFound is a 404 with code "not_found".
func NotFound(hint, format string, args ...any) *Error {
	return Errorf(http.StatusNotFound, "not_found", hint, format, args...)
}

// Conflict is a 409: the request is well formed but clashes with the
// current state (a name in use, a change made since, a guard).
func Conflict(code, hint, format string, args ...any) *Error {
	return Errorf(http.StatusConflict, code, hint, format, args...)
}

// WithDetails returns e with Details set.
func (e *Error) WithDetails(d any) *Error {
	c := *e
	c.Details = d
	return &c
}

// MaxNameLen is the longest name CheckName accepts.
const MaxNameLen = 64

// reservedNames cannot be used as names because they are path words of
// the admin API (POST /api/<resource>/bulk).
var reservedNames = map[string]bool{"bulk": true}

// CheckName validates the name of an admin resource (Admin Token, Gateway
// Key, Model Pool...): 1 to 64 characters, letters, digits, '.', '_' and
// '-', starting with a letter or digit, and not a reserved path word.
// Names address records in URLs, so they never contain '/' or spaces.
func CheckName(field, name string) error {
	hint := fmt.Sprintf("Use 1 to %d letters, digits, '.', '_' or '-' for %s, starting with a letter or digit, e.g. \"zeron-fleet\".", MaxNameLen, field)
	if name == "" {
		return BadRequest(hint, "%s is required.", field)
	}
	if len(name) > MaxNameLen {
		return BadRequest(hint, "%s is longer than %d characters.", field, MaxNameLen)
	}
	for i, c := range name {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '.' || c == '_' || c == '-')
		if !ok {
			return BadRequest(hint, "%s %q contains %q at position %d.", field, name, c, i+1)
		}
	}
	if reservedNames[strings.ToLower(name)] {
		return BadRequest("Pick another name; \""+name+"\" is a word of the admin API's paths.", "%s %q is reserved.", field, name)
	}
	return nil
}

// AsError returns err as an *Error, wrapping anything else as a 500.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		c := *e
		if c.Status == 0 {
			c.Status = http.StatusInternalServerError
		}
		if c.Hint == "" {
			c.Hint = "See GET /api/openapi.json for this route's contract."
		}
		return &c
	}
	return &Error{
		Status:  http.StatusInternalServerError,
		Code:    "internal",
		Message: "Iroha failed to handle the request.",
		Hint:    "Retry once; if it fails again read GET /api/logs?level=error&since=5m for the cause.",
	}
}
