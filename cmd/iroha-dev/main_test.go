package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
)

func launch(t *testing.T, args ...string) (Output, func() string) {
	t.Helper()
	o, err := parse(args, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	var stderr bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- run(ctx, o, clock.Real{}, pw, &stderr); pw.Close() }()
	var out Output
	if err := json.NewDecoder(pr).Decode(&out); err != nil {
		cancel()
		t.Fatalf("no JSON from the launcher: %v; stderr: %s; run: %v", err, stderr.String(), <-done)
	}
	go io.Copy(io.Discard, pr)
	stopped := false
	stop := func() string {
		if !stopped {
			stopped = true
			cancel()
			if err := <-done; err != nil {
				t.Errorf("launcher: %v", err)
			}
		}
		return stderr.String()
	}
	t.Cleanup(func() { stop() })
	return out, stop
}

func call(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func TestTheDemoLaunchSeedsEveryKeyStateAndCleansUp(t *testing.T) {
	out, stop := launch(t, "--exit-after", "0")
	if out.AdminToken == "" || out.GatewayKeys["laptop"] == "" || out.GatewayKeys["ci"] == "" || out.GatewayKeys["friend"] == "" {
		t.Fatalf("missing secrets: %+v", out)
	}
	env, err := os.ReadFile(out.EnvFile)
	if err != nil || !strings.Contains(string(env), "IROHA_KEY_LAPTOP='"+out.GatewayKeys["laptop"]+"'") || !strings.Contains(string(env), "FAKE_OPENAI_CHAT_CONTROL='") {
		t.Fatalf("env file %s: %v\n%s", out.EnvFile, err, env)
	}
	if !out.DeletedOnExit {
		t.Fatal("a temporary data dir should be deleted on exit")
	}
	if len(out.Fakes) != 4 {
		t.Fatalf("fakes %v, want one per Shape", out.Fakes)
	}
	states := map[string]bool{}
	for _, s := range out.Seeded.KeyStates {
		states[s] = true
	}
	for _, s := range []string{"cooling", "invalid", "disabled"} {
		if !states[s] {
			t.Errorf("no seeded key is %s: %v", s, out.Seeded.KeyStates)
		}
	}
	code, stats := call(t, "GET", out.BaseURL+"/api/requests/stats", out.AdminToken, nil)
	tokens, _ := stats["tokens"].(map[string]any)
	if code != 200 || stats["failed"].(float64) < 1 || tokens["cache_read"].(float64) <= 0 {
		t.Fatalf("stats %d %v: want a failed Request and cache reads", code, stats)
	}

	chat := out.Fakes["openai-chat"].Control
	if code, _ := call(t, "POST", chat+"/next?reply=429", "", nil); code != 200 {
		t.Fatalf("queue a 429: %d", code)
	}
	code, _ = call(t, "POST", out.BaseURL+"/v1/chat/completions", out.GatewayKeys["laptop"], map[string]any{
		"model": "mistral/mistral-small-latest", "messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	if code != 429 && code != 503 {
		t.Fatalf("one key answering 429: Caller got %d", code)
	}
	_, got := call(t, "GET", chat+"/requests", "", nil)
	if reqs, _ := got["requests"].([]any); len(reqs) != 1 {
		t.Fatalf("fake requests after the seed reset: %v", got)
	}

	if _, err := localOnly().Get("http://example.com/"); err == nil || !strings.Contains(err.Error(), "only the localhost fakes") {
		t.Fatalf("outbound call to example.com: %v", err)
	}

	logs := stop()
	if _, err := os.Stat(out.DataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("data dir %s still there after stop (%v); stderr %s", out.DataDir, err, logs)
	}
}

func TestAReusedDataDirKeepsItsSecretsAndMovesItsEndpoints(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	first, stop := launch(t, "--data-dir", dir, "--exit-after", "0")
	stop()
	second, _ := launch(t, "--data-dir", dir, "--exit-after", "0")
	if second.AdminToken != first.AdminToken || second.GatewayKeys["laptop"] != first.GatewayKeys["laptop"] || second.Seed != "demo" {
		t.Fatalf("second run lost the first run's secrets: %+v", second)
	}
	if second.DeletedOnExit {
		t.Fatal("a --data-dir must never be deleted")
	}
	code, body := call(t, "POST", second.BaseURL+"/v1/messages", second.GatewayKeys["laptop"], map[string]any{
		"model": "anthropic/claude-haiku-4-5", "max_tokens": 16, "messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	if code != 200 {
		t.Fatalf("Caller request on the reused dir: %d %v (Endpoints not moved to the new fakes?)", code, body)
	}
}

func TestBadFlagsSayWhatToDo(t *testing.T) {
	for args, want := range map[string]string{
		"--seed=lots":          "--seed must be demo or none",
		"--port=70000":         "--port must be from 0",
		"--owner-password=abc": "at least 8 characters",
		"--nope":               "run with --help",
		"extra":                "run with --help",
	} {
		_, err := parse(strings.Fields(args), io.Discard)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", args, err, want)
		}
	}
	var help bytes.Buffer
	if _, err := parse([]string{"--help"}, &help); !errors.Is(err, flag.ErrHelp) || !strings.Contains(help.String(), "--seed demo|none") {
		t.Fatalf("--help: %v %q", err, help.String())
	}
}

func TestATakenPortIsNamed(t *testing.T) {
	out, _ := launch(t, "--seed", "none", "--exit-after", "0")
	port := out.BaseURL[strings.LastIndex(out.BaseURL, ":")+1:]
	o, _ := parse([]string{"--port", port, "--seed", "none"}, io.Discard)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := run(ctx, o, clock.Real{}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "pass another --port") {
		t.Fatalf("second launcher on port %s: %v", port, err)
	}
}
