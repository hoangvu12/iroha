package api

import (
	"errors"
	"fmt"
	"net/http"
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
