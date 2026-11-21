package gateway_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestASlowCallerSlowsTheUpstreamRead(t *testing.T) {
	const (
		events    = 1536
		eventSize = 32 << 10
	)
	for _, tc := range []struct {
		name, path string
		body       map[string]any
		header     string
		last       string
	}{
		{"passthrough", chatPath, map[string]any{"model": "gpt-x", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hi"}}},
			"Authorization", "data: [DONE]"},
		{"translated", messagesPath, map[string]any{"model": "gpt-x", "stream": true, "max_tokens": 256, "messages": []any{map[string]any{"role": "user", "content": "hi"}}},
			"X-Api-Key", `"type":"message_stop"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := testkit.Start(t)
			up := testkit.NewOpenAIChat(t)
			addProvider(t, srv, "acme", up.URL(), "sk-test-one")
			secret := issue(t, srv, "slow-reader", all)

			piece := strings.Repeat("x", eventSize-150)
			chunk := func(delta, finish any) string {
				b, _ := json.Marshal(map[string]any{"id": "chatcmpl-big", "object": "chat.completion.chunk", "created": 1767225600, "model": "gpt-x",
					"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
				return "data: " + string(b) + "\n\n"
			}
			stream := []string{chunk(map[string]any{"role": "assistant", "content": ""}, nil)}
			for range events {
				stream = append(stream, chunk(map[string]any{"content": piece}, nil))
			}
			stream = append(stream, chunk(map[string]any{}, "stop"), "data: [DONE]\n\n")
			total := 0
			for _, e := range stream {
				total += len(e)
			}
			up.Enqueue(testkit.SSE(stream...))

			body, _ := json.Marshal(tc.body)
			req, _ := http.NewRequest(http.MethodPost, srv.URL+tc.path, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			if tc.header == "Authorization" {
				req.Header.Set("Authorization", "Bearer "+secret)
			} else {
				req.Header.Set(tc.header, secret)
			}
			client := &http.Client{Transport: &http.Transport{DisableCompression: true}}
			t.Cleanup(client.CloseIdleConnections)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("status %d", resp.StatusCode)
			}

			stalled := settle(up.Written)
			if stalled > int64(total)/3 {
				t.Fatalf("the fake wrote %d of %d bytes while the Caller read nothing", stalled, total)
			}

			got, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("reading the answer after %d bytes: %v", len(got), err)
			}
			if !bytes.Contains(got[max(0, len(got)-512):], []byte(tc.last)) || len(got) < total/2 {
				t.Fatalf("the Caller got %d bytes ending %q", len(got), got[max(0, len(got)-200):])
			}
			if n := strings.Count(string(got), piece); n != events {
				t.Fatalf("the Caller got %d of %d pieces", n, events)
			}
			if w := up.Written(); w != int64(total) {
				t.Fatalf("the fake wrote %d of %d bytes", w, total)
			}
			t.Logf("stalled at %d of %d bytes (%.1f%%)", stalled, total, 100*float64(stalled)/float64(total))
		})
	}
}

func settle(n func() int64) int64 {
	last, since := n(), time.Now()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
		if v := n(); v != last {
			last, since = v, time.Now()
			continue
		}
		if time.Since(since) >= 300*time.Millisecond {
			break
		}
	}
	return last
}
