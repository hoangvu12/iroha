package gateway

import "testing"

func TestSetFieldEditsOnlyThatValue(t *testing.T) {
	cases := []struct {
		name, in, key, value, want string
		ok                         bool
	}{
		{"replace keeps spacing and order", `{"z":1, "model" : "a",  "x":{"model":"inner"}}`, "model", `"b"`, `{"z":1, "model" : "b",  "x":{"model":"inner"}}`, true},
		{"append when absent", `{"model":"a"}`, "stream_options", `{"include_usage":true}`, `{"model":"a","stream_options":{"include_usage":true}}`, true},
		{"append to an empty object", ` {} `, "k", `1`, ` {"k":1} `, true},
		{"replace an object value", `{"stream_options":{"x":1},"n":2}`, "stream_options", `{"x":1,"include_usage":true}`, `{"stream_options":{"x":1,"include_usage":true},"n":2}`, true},
		{"escaped key names match", `{"model":"a"}`, "model", `"b"`, `{"model":"b"}`, true},
		{"not an object", `[1,2]`, "model", `"b"`, `[1,2]`, false},
		{"broken JSON", `{"model":`, "model", `"b"`, `{"model":`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := setField([]byte(tc.in), tc.key, []byte(tc.value))
			if string(got) != tc.want || ok != tc.ok {
				t.Fatalf("setField = %s, %v; want %s, %v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestEchoModel(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"id":"x","model":"gpt-4o-2024-08-06","choices":[]}`, `{"id":"x","model":"gpt-4o","choices":[]}`},
		{`{"id":"x","model":"gpt-4o"}`, `{"id":"x","model":"gpt-4o"}`},
		{`{"id":"x"}`, `{"id":"x"}`},
		{`{"model":null}`, `{"model":null}`},
		{`not json "model"`, `not json "model"`},
	}
	for _, tc := range cases {
		if got := string(echoModel([]byte(tc.in), "gpt-4o")); got != tc.want {
			t.Errorf("echoModel(%s) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
