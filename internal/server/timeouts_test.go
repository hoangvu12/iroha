package server

import (
	"log/slog"
	"testing"
)

// A server-wide read, write or idle timeout would cut long streams (a model
// thinking for minutes); only the request headers are time-limited.
func TestNoServerWideTimeoutCutsLongStreams(t *testing.T) {
	s := &Server{log: slog.New(slog.DiscardHandler)}
	h := s.newHTTPServer()
	if h.ReadTimeout != 0 || h.WriteTimeout != 0 || h.IdleTimeout != 0 || h.ReadHeaderTimeout == 0 {
		t.Fatalf("timeouts: read %v, write %v, idle %v, header %v", h.ReadTimeout, h.WriteTimeout, h.IdleTimeout, h.ReadHeaderTimeout)
	}
}
