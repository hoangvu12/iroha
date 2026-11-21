package fakeupstream_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/fakeupstream"
	"github.com/hoangvu12/iroha/internal/shape"
)

func do(t *testing.T, method, url, key, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if key != "" {
		req.Header.Set("x-api-key", key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestControlQueuesRepliesAndShowsWhatArrived(t *testing.T) {
	u := fakeupstream.New(shape.AnthropicMessages, clock.Real{})
	defer u.Close()
	u.EnableControl()
	msg := `{"model":"m","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}`

	if code, body := do(t, "POST", u.ControlURL()+"/next?reply=429&count=2&retry_after=7", "", ""); code != 200 || !strings.Contains(body, `"queued":2`) {
		t.Fatalf("next: %d %s", code, body)
	}
	for i := 0; i < 2; i++ {
		if code, body := do(t, "POST", u.URL()+"/messages", "sk-ok", msg); code != 429 || !strings.Contains(body, "rate_limit_error") {
			t.Fatalf("queued reply %d: %d %s", i, code, body)
		}
	}
	if code, _ := do(t, "POST", u.URL()+"/messages", "sk-ok", msg); code != 200 {
		t.Fatalf("after the queue: %d", code)
	}
	if code, _ := do(t, "POST", u.URL()+"/messages", "sk-demo-fail401", msg); code != 401 {
		t.Fatalf("marked key: %d", code)
	}

	_, body := do(t, "GET", u.ControlURL()+"/requests?last=1", "", "")
	var got struct {
		Requests []fakeupstream.ReceivedView `json:"requests"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.Requests) != 1 {
		t.Fatalf("requests: %v %s", err, body)
	}
	r := got.Requests[0]
	if r.Seq != 4 || r.Header["x-api-key"] != "sk-demo-fail401" || r.Model != "m" || !strings.Contains(string(r.Body), `"max_tokens":5`) || r.Raw != msg {
		t.Fatalf("request view %+v", r)
	}

	if code, body := do(t, "POST", u.ControlURL()+"/next?reply=teapot", "", ""); code != 400 || !strings.Contains(body, "one of") {
		t.Fatalf("unknown reply: %d %s", code, body)
	}
	do(t, "POST", u.ControlURL()+"/reset", "", "")
	if u.Count() != 0 {
		t.Fatalf("reset kept %d requests", u.Count())
	}
}

func TestControlIsOffUnlessEnabled(t *testing.T) {
	u := fakeupstream.New(shape.OpenAIChat, clock.Real{})
	defer u.Close()
	if code, _ := do(t, "GET", u.ControlURL()+"/", "", ""); code != 404 {
		t.Fatalf("control without EnableControl: %d", code)
	}
	if code, _ := do(t, "POST", u.URL()+"/chat/completions", "", `{"model":"m","messages":[]}`); code != 200 {
		t.Fatalf("plain reply: %d", code)
	}
}

func TestCacheReadsAppearInEveryShapesUsage(t *testing.T) {
	want := map[shape.Shape]string{
		shape.OpenAIChat:        `"cached_tokens":30`,
		shape.OpenAIResponses:   `"cached_tokens":30`,
		shape.AnthropicMessages: `"cache_read_input_tokens":30`,
		shape.Gemini:            `"cachedContentTokenCount":30`,
	}
	paths := map[shape.Shape]string{
		shape.OpenAIChat: "/chat/completions", shape.OpenAIResponses: "/responses",
		shape.AnthropicMessages: "/messages", shape.Gemini: "/models/g:generateContent",
	}
	for sh, frag := range want {
		u := fakeupstream.New(sh, clock.Real{})
		u.SetUsageWith(fakeupstream.Usage{Input: 100, Output: 5, CacheRead: 30})
		_, body := do(t, "POST", u.URL()+paths[sh], "", `{"model":"m","input":"x","messages":[]}`)
		u.Close()
		if !strings.Contains(body, frag) {
			t.Errorf("%s: %s lacks %s", sh, body, frag)
		}
	}
}
