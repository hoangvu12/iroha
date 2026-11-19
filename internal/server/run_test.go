package server_test

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/server"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// runFreeAddr is a loopback address nothing listens on right now.
func runFreeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

// RUN-01: a data directory Iroha cannot use stops the start: Run returns an
// error naming the problem, nothing listens and no startup event is logged.
func TestRunFailsBeforeListeningWhenTheDataDirectoryIsUnusable(t *testing.T) {
	base := t.TempDir()
	notADir := filepath.Join(base, "file")
	if err := os.WriteFile(notADir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	dbIsADir := filepath.Join(base, "data")
	if err := os.MkdirAll(filepath.Join(dbIsADir, "iroha.db"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, dir string }{
		{"data dir is a file", notADir},
		{"iroha.db is a directory", dbIsADir},
	} {
		t.Run(tc.name, func(t *testing.T) {
			addr := runFreeAddr(t)
			console := &lockedBuffer{}
			done := make(chan error, 1)
			go func() {
				done <- server.Run(context.Background(), server.Options{
					Config:  config.Config{DataDir: tc.dir, Addr: addr, LogLevel: slog.LevelInfo, LogFormat: "json", DrainTimeout: time.Second},
					Version: "test", Console: console,
				})
			}()
			var err error
			select {
			case err = <-done:
			case <-time.After(10 * time.Second):
				t.Fatal("Run did not return")
			}
			if err == nil {
				t.Fatal("Run started on an unusable data directory")
			}
			if strings.Contains(console.String(), `"kind":"startup"`) {
				t.Fatalf("a startup event was logged:\n%s", console.String())
			}
			// Nothing holds the address.
			ln, lerr := net.Listen("tcp", addr)
			if lerr != nil {
				t.Fatalf("%s is still taken after the failed start: %v", addr, lerr)
			}
			ln.Close()
		})
	}
}

// RUN-03: once a shutdown begins, /readyz answers 503 not_ready to anything
// that still reaches it, while in-flight Requests drain.
func TestReadinessTurnsOffAsSoonAsTheDrainBegins(t *testing.T) {
	srv := testkit.Start(t)
	gate := make(chan struct{})
	_, body := gatewayStream(t, srv, gate)
	handler := srv.App.Handler()
	readyz := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		return w
	}
	if w := readyz(); w.Code != 200 {
		t.Fatalf("readyz before the drain = %d %s", w.Code, w.Body)
	}

	stopped := stopInBackground(srv, 10*time.Second)
	deadline := time.Now().Add(5 * time.Second)
	var w *httptest.ResponseRecorder
	for w = readyz(); w.Code == 200; w = readyz() {
		if time.Now().After(deadline) {
			t.Fatal("readyz still 200 after the drain began")
		}
		time.Sleep(2 * time.Millisecond)
	}
	if w.Code != 503 || !strings.Contains(w.Body.String(), `"not_ready"`) || strings.Contains(w.Body.String(), srv.DataDir) {
		t.Fatalf("readyz during the drain = %d %s", w.Code, w.Body)
	}
	select {
	case <-stopped:
		t.Fatal("the drain ended while a stream was in flight")
	default:
	}
	close(gate)
	readUntil(t, body, "[DONE]")
	waitStopped(t, stopped, 5*time.Second)
}

// RUN-05: a second SIGTERM during the drain changes nothing: Run returns
// once, after one shutdown event.
func TestASecondSignalDuringTheDrainIsAbsorbed(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	srv := runServer(t, 10*time.Second, slowRoute(entered, release))
	srv.startSlow(entered)
	srv.stop()
	srv.stop()
	close(release)
	if err := srv.waitDone(5 * time.Second); err != nil {
		t.Fatalf("Run: %v", err)
	}
	n := strings.Count(srv.console.String(), `"kind":"shutdown"`)
	if sd := srv.event("shutdown"); n != 1 || sd["drained"] != true {
		t.Fatalf("%d shutdown events, last %v", n, sd)
	}
}
