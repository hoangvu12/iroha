package affinity_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/affinity"
	"github.com/hoangvu12/iroha/internal/shape"
)

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

const chatBody = `{"model":"m","messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Fix the bug"}]}`

// Each source is found, in the order the ticket lists, and two sources with
// the same session value name the same conversation.
func TestEachSourceIsFoundInOrder(t *testing.T) {
	cases := []struct {
		name   string
		h      http.Header
		body   string
		sh     shape.Shape
		source affinity.Source
		same   string // a session value this case must equal, when it carries one
	}{
		{"Iroha-Session wins over everything", hdr("Iroha-Session", "s-1", "X-Claude-Code-Session-Id", "cc-1"), chatBody, shape.OpenAIChat, affinity.Header, "s-1"},
		{"Claude Code header", hdr("X-Claude-Code-Session-Id", "cc-1", "Session_id", "codex-1"), chatBody, shape.AnthropicMessages, affinity.ClaudeCode, "cc-1"},
		{"Claude Code metadata.user_id, JSON form", nil,
			`{"model":"m","metadata":{"user_id":"{\"device_id\":\"d\",\"account_uuid\":\"a\",\"session_id\":\"cc-2\"}"},"messages":[{"role":"user","content":"hi"}]}`,
			shape.AnthropicMessages, affinity.ClaudeCode, "cc-2"},
		{"Claude Code metadata.user_id, legacy form", nil,
			`{"model":"m","metadata":{"user_id":"user_abc123_account_0f9e_session_6a1b2c3d-0000-4e5f-8a9b-112233445566"},"messages":[]}`,
			shape.AnthropicMessages, affinity.ClaudeCode, "6a1b2c3d-0000-4e5f-8a9b-112233445566"},
		{"Codex session_id header", hdr("Session_id", "codex-1", "X-Session-Id", "x-1"), chatBody, shape.OpenAIResponses, affinity.Codex, "codex-1"},
		{"Codex session-id header", hdr("Session-Id", "codex-2"), chatBody, shape.OpenAIResponses, affinity.Codex, "codex-2"},
		{"Codex thread-id header", hdr("Thread-Id", "th-1"), chatBody, shape.OpenAIResponses, affinity.Codex, "th-1"},
		{"x-session-id", hdr("X-Session-Id", "x-1", "X-Session-Affinity", "oc-1"), chatBody, shape.OpenAIChat, affinity.SessionID, "x-1"},
		{"OpenCode x-session-affinity", hdr("X-Session-Affinity", "oc-1"), chatBody, shape.OpenAIChat, affinity.OpenCode, "oc-1"},
		{"body session_id", nil, `{"model":"m","session_id":"b-1","prompt_cache_key":"p-1","messages":[]}`, shape.OpenAIChat, affinity.SessionID, "b-1"},
		{"prompt_cache_key", nil, `{"model":"m","prompt_cache_key":"p-1","messages":[]}`, shape.OpenAIResponses, affinity.PromptCacheKey, "p-1"},
		{"prefix of a Chat prompt", nil, chatBody, shape.OpenAIChat, affinity.Prefix, ""},
		{"plain user is not a session", nil, `{"model":"m","user":"linh","messages":[{"role":"user","content":"hi"}]}`, shape.OpenAIChat, affinity.Prefix, ""},
		{"empty prompt: none", nil, `{"model":"m","messages":[]}`, shape.OpenAIChat, affinity.None, ""},
		{"blank header is ignored", hdr("Iroha-Session", "   "), `{"model":"m","messages":[]}`, shape.OpenAIChat, affinity.None, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := tc.h
			if h == nil {
				h = http.Header{}
			}
			c := affinity.Identify(h, []byte(tc.body))
			if c.Source != tc.source {
				t.Fatalf("source = %q, want %q", c.Source, tc.source)
			}
			if (c.ID == "") != (tc.source == affinity.None) {
				t.Fatalf("id = %q for source %q", c.ID, c.Source)
			}
			if tc.same != "" {
				want := affinity.Identify(hdr("Iroha-Session", tc.same), nil)
				if c.ID != want.ID {
					t.Fatalf("session %q from %s names another conversation than the same value in Iroha-Session", tc.same, tc.source)
				}
			}
		})
	}
}

// The prefix is the system prompt, the tool names and the first user
// message, in every Shape: a later turn of the conversation keeps it, a
// different first message changes it.
func TestThePrefixIsStableAcrossTurnsInEveryShape(t *testing.T) {
	cases := []struct {
		sh                  shape.Shape
		turn1, turn2, other string
	}{
		{shape.OpenAIChat,
			`{"model":"m","tools":[{"type":"function","function":{"name":"read"}}],"messages":[{"role":"system","content":"S"},{"role":"user","content":"Fix the bug"}]}`,
			`{"model":"m","stream":true,"tools":[{"type":"function","function":{"name":"read"}}],"messages":[{"role":"system","content":"S"},{"role":"user","content":[{"type":"text","text":"Fix the bug"}]},{"role":"assistant","content":"Done"},{"role":"user","content":"Thanks"}]}`,
			`{"model":"m","tools":[{"type":"function","function":{"name":"write"}}],"messages":[{"role":"system","content":"S"},{"role":"user","content":"Fix the bug"}]}`},
		{shape.AnthropicMessages,
			`{"model":"m","system":[{"type":"text","text":"S","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"read"}],"messages":[{"role":"user","content":[{"type":"text","text":"Fix the bug","cache_control":{"type":"ephemeral"}}]}]}`,
			`{"model":"m","system":[{"type":"text","text":"S","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"read"}],"messages":[{"role":"user","content":[{"type":"text","text":"Fix the bug"}]},{"role":"assistant","content":"Done"},{"role":"user","content":[{"type":"text","text":"Thanks","cache_control":{"type":"ephemeral"}}]}]}`,
			`{"model":"m","system":"Other system","tools":[{"name":"read"}],"messages":[{"role":"user","content":"Fix the bug"}]}`},
		{shape.OpenAIResponses,
			`{"model":"m","instructions":"S","tools":[{"type":"function","name":"read"}],"input":"Fix the bug"}`,
			`{"model":"m","instructions":"S","tools":[{"type":"function","name":"read"}],"input":[{"role":"user","content":[{"type":"input_text","text":"Fix the bug"}]},{"type":"function_call","name":"read","arguments":"{}","call_id":"c1"},{"type":"function_call_output","call_id":"c1","output":"x"}]}`,
			`{"model":"m","instructions":"S","tools":[{"type":"function","name":"read"}],"input":"Write a poem"}`},
		{shape.Gemini,
			`{"systemInstruction":{"parts":[{"text":"S"}]},"tools":[{"functionDeclarations":[{"name":"read"}]}],"contents":[{"role":"user","parts":[{"text":"Fix the bug"}]}]}`,
			`{"systemInstruction":{"parts":[{"text":"S"}]},"tools":[{"functionDeclarations":[{"name":"read"}]}],"contents":[{"role":"user","parts":[{"text":"Fix the bug"}]},{"role":"model","parts":[{"text":"Done"}]},{"role":"user","parts":[{"text":"Thanks"}]}]}`,
			`{"systemInstruction":{"parts":[{"text":"Other"}]},"tools":[{"functionDeclarations":[{"name":"read"}]}],"contents":[{"role":"user","parts":[{"text":"Fix the bug"}]}]}`},
	}
	for _, tc := range cases {
		t.Run(string(tc.sh), func(t *testing.T) {
			a := affinity.Identify(http.Header{}, []byte(tc.turn1))
			b := affinity.Identify(http.Header{}, []byte(tc.turn2))
			o := affinity.Identify(http.Header{}, []byte(tc.other))
			if a.Source != affinity.Prefix || b.Source != affinity.Prefix || o.Source != affinity.Prefix {
				t.Fatalf("sources %s %s %s", a.Source, b.Source, o.Source)
			}
			if a.ID != b.ID {
				t.Fatal("the second turn names another conversation")
			}
			if a.ID == o.ID {
				t.Fatal("a different prompt start names the same conversation")
			}
		})
	}
}

// Only the first few KB count, so a huge first message costs little and a
// change past them does not split the conversation.
func TestThePrefixReadsOnlyTheStart(t *testing.T) {
	long := strings.Repeat("a", 64<<10)
	one := `{"model":"m","messages":[{"role":"user","content":"` + long + `x"}]}`
	two := `{"model":"m","messages":[{"role":"user","content":"` + long + `y"}]}`
	if affinity.Identify(http.Header{}, []byte(one)).ID != affinity.Identify(http.Header{}, []byte(two)).ID {
		t.Fatal("bytes past the first few KB changed the conversation")
	}
}

// The same session from two Gateway Keys is two conversations: a Caller
// cannot steer another's traffic by sending its session ID.
func TestCallersCannotSteerEachOther(t *testing.T) {
	c := affinity.Identify(hdr("Iroha-Session", "shared"), nil)
	a, b := c.For("gk_a"), c.For("gk_b")
	if a.ID == b.ID || a.ID == c.ID {
		t.Fatal("scoping by Gateway Key did not change the conversation")
	}
	if a.Source != affinity.Header || c.For("gk_a").ID != a.ID {
		t.Fatal("scoping is not stable")
	}
	if affinity.Key(a.ID, "pr_1", "m") == affinity.Key(a.ID, "pr_2", "m") || affinity.Key(a.ID, "pr_1", "m") == affinity.Key(a.ID, "pr_1", "n") {
		t.Fatal("the key does not depend on Provider and model")
	}
	if none := (affinity.Conversation{Source: affinity.None}).For("gk_a"); none.ID != "" {
		t.Fatal("scoping invented a conversation")
	}
	if affinity.Key("", "pr_1", "m") != "" {
		t.Fatal("no conversation must give no key")
	}
}

// Half the conversations fall in the experiment's round-robin half.
func TestTheExperimentSplitsConversationsInHalves(t *testing.T) {
	control := 0
	for i := range 2000 {
		c := affinity.Identify(hdr("Iroha-Session", "s-"+strings.Repeat("x", i%7)+string(rune('a'+i%26))+strconv.Itoa(i)), nil).For("gk")
		if c.Control() {
			control++
		}
	}
	if control < 900 || control > 1100 {
		t.Fatalf("%d of 2000 in the control half", control)
	}
}

// A metadata.user_id is either Claude Code's (a session, in its JSON or
// legacy form) or a plain user; translation sends only the plain one on.
func TestMetadataUserIDTellsAUserFromClaudeCodesSession(t *testing.T) {
	for _, tc := range []struct{ raw, user, session string }{
		{`"user-7"`, "user-7", ""},
		{`" user-7 "`, "user-7", ""},
		{`"{\"device_id\":\"d\",\"session_id\":\"cc-2\"}"`, "", "cc-2"},
		{`"{\"device_id\":\"d\"}"`, "", ""},
		{`"user_abc_account_0f9e_session_6a1b2c3d-0000-4e5f-8a9b-112233445566"`, "", "6a1b2c3d-0000-4e5f-8a9b-112233445566"},
		{`{"session_id":"cc-3"}`, "", "cc-3"},
		{`42`, "", ""},
		{``, "", ""},
	} {
		user, session := affinity.MetadataUserID(json.RawMessage(tc.raw))
		if user != tc.user || session != tc.session {
			t.Errorf("MetadataUserID(%s) = %q, %q; want %q, %q", tc.raw, user, session, tc.user, tc.session)
		}
	}
}
