package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code" doc:"Stable machine-readable error code."`
	Message string `json:"message" doc:"What went wrong."`
	Hint    string `json:"hint" doc:"What to do next."`
	Details any    `json:"details,omitempty" doc:"Extra structured context, when any."`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

type ErrorBody struct {
	Error *Error `json:"error"`
}

func Errorf(status int, code, hint, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...), Hint: hint}
}

func BadRequest(hint, format string, args ...any) *Error {
	return Errorf(http.StatusBadRequest, "invalid_request", hint, format, args...)
}

func NotFound(hint, format string, args ...any) *Error {
	return Errorf(http.StatusNotFound, "not_found", hint, format, args...)
}

func Conflict(code, hint, format string, args ...any) *Error {
	return Errorf(http.StatusConflict, code, hint, format, args...)
}

func (e *Error) WithDetails(d any) *Error {
	c := *e
	c.Details = d
	return &c
}

const MaxNameLen = 64

var reservedNames = map[string]bool{"bulk": true}

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
