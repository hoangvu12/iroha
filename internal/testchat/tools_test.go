package testchat_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/testchat"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestToolListNamesEveryTestTool(t *testing.T) {
	srv := testkit.Start(t)
	var got testchat.ToolList
	srv.Admin.Get("/api/test/tools").OK().JSON(&got)
	want := []string{"get_weather", "get_time", "calculate", "web_search", "fetch_url", "lookup_order"}
	if len(got.Tools) != len(want) {
		t.Fatalf("tools %+v", got.Tools)
	}
	for i, tool := range got.Tools {
		var schema struct {
			Type       string
			Properties map[string]any
			Required   []string
		}
		if err := json.Unmarshal(tool.Parameters, &schema); err != nil || tool.Name != want[i] || tool.Description == "" ||
			schema.Type != "object" || len(schema.Properties) == 0 || len(schema.Required) == 0 {
			t.Fatalf("tool %d: %s %q %s", i, tool.Name, tool.Description, tool.Parameters)
		}
	}
}

func toolStream(name, args string) string {
	a, _ := json.Marshal(args)
	return fmt.Sprintf(`data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":%q,"arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":%s}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

`, name, a)
}

func TestChosenToolsAreOfferedAndCheckedInEveryShape(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	for _, sh := range shapes {
		t.Run(sh, func(t *testing.T) {
			up.Enqueue(testkit.SSE(toolStream("calculate", `{"expression": "2^10 + 1"}`)))
			resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "shape": sh, "tools": []any{"get_weather", "calculate", "lookup_order"}})).Expect(200)
			c := toolCheck(t, resp.Body)
			if !c.Passed || c.Name != "calculate" || !strings.Contains(c.Arguments, "2^10") {
				t.Fatalf("check %+v in %s", c, resp.Body)
			}
			var body struct {
				Tools []struct{ Function struct{ Name string } }
			}
			up.Last().JSON(t, &body)
			var names []string
			for _, tl := range body.Tools {
				names = append(names, tl.Function.Name)
			}
			if strings.Join(names, ",") != "get_weather,calculate,lookup_order" {
				t.Fatalf("upstream tools %v: %s", names, up.Last().Body)
			}
		})
	}
}

func TestToolCheckFailsCallsOutsideTheOfferOrAgainstTheSchema(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	for _, tc := range []struct {
		name, args string
		tools      []any
		reason     string
	}{
		{"get_time", `{"timezone": "UTC"}`, []any{"calculate"}, "not offered"},
		{"get_time", `{"zone": "UTC"}`, []any{"get_time"}, "lack timezone"},
		{"web_search", `{"query": "go", "max_results": "three"}`, []any{"web_search"}, "max_results as an integer"},
		{"lookup_order", `{"order_id": ""}`, []any{"lookup_order"}, "empty order_id"},
		{"fetch_url", `[1]`, []any{"fetch_url"}, "not a JSON object"},
	} {
		up.Enqueue(testkit.SSE(toolStream(tc.name, tc.args)))
		resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "tools": tc.tools})).Expect(200)
		if c := toolCheck(t, resp.Body); c.Passed || !strings.Contains(c.Reason, tc.reason) || c.Name != tc.name {
			t.Fatalf("%s(%s): check %+v, want %q", tc.name, tc.args, c, tc.reason)
		}
	}
	up.Enqueue(up.Text("No tools today."))
	resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "tools": []any{"fetch_url"}})).Expect(200)
	if c := toolCheck(t, resp.Body); c.Passed || c.Reason != "The model answered without calling fetch_url." {
		t.Fatalf("check %+v", c)
	}
	n := up.Count()
	resp = srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "tools": []any{"get_weather", "teleport"}})).Expect(400)
	if !strings.Contains(resp.Text(), "unknown_tool") || up.Count() != n {
		t.Fatalf("answer %s", resp.Body)
	}
}

func followUp(t *testing.T, srv *testkit.Server, up *testkit.Upstream, name, args string) map[string]any {
	t.Helper()
	up.Enqueue(up.Text("ok"))
	srv.Admin.Post("/api/test", map[string]any{"model": "acme/m", "stream": false, "tools": []any{name}, "messages": []any{
		map[string]any{"role": "user", "content": "Go"},
		map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "call_1", "name": name, "arguments": args}}},
		map[string]any{"role": "user", "content": "Thanks"},
	}}).Expect(200)
	var body struct {
		Messages []struct {
			Role    string
			Content string
		}
	}
	up.Last().JSON(t, &body)
	if len(body.Messages) != 4 || body.Messages[2].Role != "tool" {
		t.Fatalf("upstream got %s", up.Last().Body)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(body.Messages[2].Content), &out); err != nil {
		t.Fatalf("tool result %q: %v", body.Messages[2].Content, err)
	}
	return out
}

func TestEachToolIsAnsweredByIroha(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")

	if w := followUp(t, srv, up, "get_weather", `{"city":"Da Nang"}`); w["city"] != "Da Nang" || w["temperature_c"] == nil {
		t.Fatalf("weather %v", w)
	}

	tm := followUp(t, srv, up, "get_time", `{"timezone":"Asia/Ho_Chi_Minh"}`)
	loc, _ := time.LoadLocation("Asia/Ho_Chi_Minh")
	want := srv.Clock.Now().In(loc)
	got, err := time.Parse(time.RFC3339, fmt.Sprint(tm["datetime"]))
	if err != nil || got.Sub(want).Abs() > time.Second || tm["utc_offset"] != "+07:00" || tm["weekday"] != want.Weekday().String() {
		t.Fatalf("time %v, want %s", tm, want)
	}
	if bad := followUp(t, srv, up, "get_time", `{"timezone":"Mars/Olympus"}`); bad["error"] == nil {
		t.Fatalf("unknown zone %v", bad)
	}

	for expr, want := range map[string]any{
		"(12.5 * 4) / 3 + 2^10": 1040.6666666666667,
		"2^3^2":                 float64(512),
		"-3 + sqrt(16) * 2":     float64(5),
		"17 % 5 + max(1, 7, 3)": float64(9),
		"round(pi * 100) / 100": 3.14,
	} {
		if r := followUp(t, srv, up, "calculate", fmt.Sprintf(`{"expression":%q}`, expr)); r["result"] != want {
			t.Fatalf("calculate %q = %v, want %v", expr, r, want)
		}
	}
	for _, expr := range []string{"1 / 0", "2 +", "foo(3)", "(1"} {
		if r := followUp(t, srv, up, "calculate", fmt.Sprintf(`{"expression":%q}`, expr)); r["error"] == nil || r["result"] != nil {
			t.Fatalf("calculate %q = %v, want an error", expr, r)
		}
	}

	s := followUp(t, srv, up, "web_search", `{"query":"sqlite wal mode","max_results":2}`)
	results, _ := s["results"].([]any)
	if s["query"] != "sqlite wal mode" || len(results) != 2 || !strings.Contains(fmt.Sprint(results[0]), "sqlite-wal-mode") {
		t.Fatalf("search %v", s)
	}

	p := followUp(t, srv, up, "fetch_url", `{"url":"https://example.com/docs/getting-started.html"}`)
	if p["title"] != "Getting started" || !strings.Contains(fmt.Sprint(p["text"]), "getting started") || p["status"] != float64(200) {
		t.Fatalf("page %v", p)
	}
	if bad := followUp(t, srv, up, "fetch_url", `{"url":"ftp://x"}`); bad["error"] == nil {
		t.Fatalf("ftp %v", bad)
	}

	o := followUp(t, srv, up, "lookup_order", `{"order_id":"ORD-10482"}`)
	again := followUp(t, srv, up, "lookup_order", `{"order_id":"ORD-10482"}`)
	items, _ := o["items"].([]any)
	shipping, _ := o["shipping"].(map[string]any)
	address, _ := shipping["address"].(map[string]any)
	total, _ := o["total"].(map[string]any)
	if o["order_id"] != "ORD-10482" || len(items) == 0 || address["city"] == nil || total["currency"] != "USD" || fmt.Sprint(o) != fmt.Sprint(again) {
		t.Fatalf("order %v (again %v)", o, again)
	}
}

func TestToolCheckAloneStillMeansGetWeather(t *testing.T) {
	srv := testkit.Start(t)
	var dry struct {
		Body struct {
			Tools []struct{ Function struct{ Name string } }
		}
	}
	srv.Admin.Post("/api/test?dry_run=true", send(map[string]any{"model": "acme/m", "tool_check": true})).OK().JSON(&dry)
	if len(dry.Body.Tools) != 1 || dry.Body.Tools[0].Function.Name != "get_weather" {
		t.Fatalf("dry run %+v", dry)
	}
	srv.Admin.Post("/api/test?dry_run=true", send(map[string]any{"model": "acme/m", "tool_check": true, "tools": []any{"get_time"}})).OK().JSON(&dry)
	if len(dry.Body.Tools) != 1 || dry.Body.Tools[0].Function.Name != "get_time" {
		t.Fatalf("dry run %+v", dry)
	}
}

func TestSnippetsCarryTheChosenTools(t *testing.T) {
	srv := testkit.Start(t)
	var sn testchat.Snippets
	q := url.Values{"model": {"acme/m"}, "tools": {"calculate,web_search"}, "base_url": {srv.URL}}
	srv.Admin.Get("/api/test/snippets?" + q.Encode()).OK().JSON(&sn)
	for _, code := range []string{sn.Curl, sn.Python, sn.TypeScript} {
		if !strings.Contains(code, "calculate") || !strings.Contains(code, "web_search") || strings.Contains(code, "get_weather") {
			t.Fatalf("snippet:\n%s", code)
		}
	}
	srv.Admin.Get("/api/test/snippets?model=acme/m&tools=nope").Expect(400)
}
