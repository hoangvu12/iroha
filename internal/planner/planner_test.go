package planner_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
)

func order(r planner.Result) string {
	var parts []string
	for _, c := range r.Candidates {
		parts = append(parts, fmt.Sprintf("%s@%s:%s", c.Key.Name, c.Endpoint.Name, c.WireModel))
	}
	return strings.Join(parts, " ")
}

func keys(names ...string) []planner.Key {
	var out []planner.Key
	for _, n := range names {
		out = append(out, planner.Key{ID: "uk_" + n, Name: n, Secret: "sk-test-" + n})
	}
	return out
}

func TestPlan(t *testing.T) {
	chat := planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}
	chatB := planner.Endpoint{ID: "ep_b", Name: "b", Shape: shape.OpenAIChat, Renames: map[string]string{"glm": "glm-4.6-b"}}
	msgs := planner.Endpoint{ID: "ep_m", Name: "m", Shape: shape.AnthropicMessages}

	cases := []struct {
		name      string
		providers []planner.Provider
		rot       planner.Rotation
		model     string
		want      string
		empty     planner.EmptyCode
	}{
		{"one endpoint, keys in order", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chat}, Keys: keys("k1", "k2", "k3")}},
			planner.Fixed(0), "glm", "k1@a:glm k2@a:glm k3@a:glm", ""},
		{"rotation starts at the counter", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chat}, Keys: keys("k1", "k2", "k3")}},
			planner.Fixed(4), "glm", "k2@a:glm k3@a:glm k1@a:glm", ""},
		{"other Shapes are not candidates", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{msgs, chat}, Keys: keys("k1")}},
			planner.Fixed(0), "glm", "k1@a:glm", ""},
		{"each key on every same-Shape Endpoint, renamed per Endpoint", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chat, chatB}, Keys: keys("k1", "k2")}},
			planner.Fixed(1), "glm", "k2@a:glm k2@b:glm-4.6-b k1@a:glm k1@b:glm-4.6-b", ""},
		{"Providers in the order given", []planner.Provider{
			{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chat}, Keys: keys("k1")},
			{ID: "q", Handle: "q", Endpoints: []planner.Endpoint{chatB}, Keys: keys("q1")},
		}, planner.Fixed(0), "glm", "k1@a:glm q1@b:glm-4.6-b", ""},
		{"Pool members ask each Provider for its own model", []planner.Provider{
			{ID: "p", Handle: "p", Model: "glm-4.6", Endpoints: []planner.Endpoint{chat}, Keys: keys("k1")},
			{ID: "q", Handle: "q", Model: "zai-org/GLM-4.6", Endpoints: []planner.Endpoint{chat}, Keys: keys("q1")},
			{ID: "r", Handle: "r", Model: "glm", Endpoints: []planner.Endpoint{chatB}, Keys: keys("r1")},
		}, planner.Fixed(0), "", "k1@a:glm-4.6 q1@a:zai-org/GLM-4.6 r1@b:glm-4.6-b", ""},
		{"no Endpoint speaks the Shape", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{msgs}, Keys: keys("k1")}},
			planner.Fixed(0), "glm", "", planner.NoEndpoint},
		{"no Upstream Keys", []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chat}}},
			planner.Fixed(0), "glm", "", planner.NoUpstreamKey},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: tc.model}, tc.providers, tc.rot)
			if got := order(r); got != tc.want {
				t.Fatalf("order = %q, want %q", got, tc.want)
			}
			switch {
			case tc.empty == "" && r.Empty != nil:
				t.Fatalf("unexpected empty: %+v", r.Empty)
			case tc.empty != "" && (r.Empty == nil || r.Empty.Code != tc.empty || r.Empty.Message == ""):
				t.Fatalf("empty = %+v, want code %s", r.Empty, tc.empty)
			}
		})
	}
}

func TestEndpointRestrictions(t *testing.T) {
	eu := planner.Endpoint{ID: "ep_eu", Name: "eu", Shape: shape.OpenAIChat}
	us := planner.Endpoint{ID: "ep_us", Name: "us", Shape: shape.OpenAIChat, Renames: map[string]string{"glm": "glm-us"}}
	msgs := planner.Endpoint{ID: "ep_m", Name: "m", Shape: shape.AnthropicMessages}
	key := func(name string, eps ...string) planner.Key {
		return planner.Key{ID: "uk_" + name, Name: name, Secret: "sk-test-" + name, Endpoints: eps}
	}
	cases := []struct {
		name  string
		eps   []planner.Endpoint
		keys  []planner.Key
		want  string
		skips string
		empty planner.EmptyCode
	}{
		{"a restricted key only goes to its Endpoints", []planner.Endpoint{eu, us}, []planner.Key{key("plan", "ep_us"), key("any")},
			"plan@us:glm-us any@eu:glm any@us:glm-us", "", ""},
		{"a key restricted to another Shape's Endpoint is skipped", []planner.Endpoint{eu, msgs}, []planner.Key{key("claude", "ep_m"), key("any")},
			"any@eu:glm", "claude:restricted", ""},
		{"nothing left but restricted keys", []planner.Endpoint{eu, msgs}, []planner.Key{key("claude", "ep_m")},
			"", "claude:restricted", planner.NoUsableKey},
		{"a keyless key is planned like any other", []planner.Endpoint{eu}, []planner.Key{{ID: "uk_free", Name: "free"}},
			"free@eu:glm", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: tc.eps, Keys: tc.keys}}
			r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now}, p, planner.Fixed(0))
			if got := order(r); got != tc.want {
				t.Fatalf("order = %q, want %q", got, tc.want)
			}
			var skips []string
			for _, s := range r.Skipped {
				skips = append(skips, s.Key.Name+":"+string(s.Reason))
			}
			if got := strings.Join(skips, " "); got != tc.skips {
				t.Fatalf("skips = %q, want %q", got, tc.skips)
			}
			if (tc.empty == "") != (r.Empty == nil) || (r.Empty != nil && (r.Empty.Code != tc.empty || !strings.Contains(r.Empty.Message, "restricted"))) {
				t.Fatalf("empty = %+v, want %q", r.Empty, tc.empty)
			}
		})
	}
}

func TestTranslationIsTheSecondTier(t *testing.T) {
	chat := planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}
	msgs := planner.Endpoint{ID: "ep_m", Name: "m", Shape: shape.AnthropicMessages, Renames: map[string]string{"glm": "glm-m"}}
	gem := planner.Endpoint{ID: "ep_g", Name: "g", Shape: shape.Gemini}
	key := func(name string, eps ...string) planner.Key {
		return planner.Key{ID: "uk_" + name, Name: name, Secret: "sk-test-" + name, Endpoints: eps}
	}
	cooling := key("hot")
	cooling.CoolingUntil = now.Add(time.Minute)
	cases := []struct {
		name  string
		eps   []planner.Endpoint
		keys  []planner.Key
		want  string
		empty planner.EmptyCode
	}{
		{"a same-Shape candidate wins", []planner.Endpoint{msgs, chat}, []planner.Key{key("k1")}, "k1@a:glm", ""},
		{"no same-Shape Endpoint: translate", []planner.Endpoint{msgs, gem}, []planner.Key{key("k1")}, "k1@m:glm-m", ""},
		{"same-Shape keys all cooling: translate", []planner.Endpoint{chat, msgs}, []planner.Key{cooling, key("claude", "ep_m")}, "claude@m:glm-m", ""},
		{"no Shape Iroha translates to", []planner.Endpoint{gem}, []planner.Key{key("k1")}, "", planner.NoEndpoint},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: tc.eps, Keys: tc.keys}}
			req := planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now, Translate: []shape.Shape{shape.AnthropicMessages}}
			r := planner.Plan(req, p, planner.Fixed(0))
			if got := order(r); got != tc.want {
				t.Fatalf("order = %q, want %q", got, tc.want)
			}
			if (tc.empty == "") != (r.Empty == nil) || (r.Empty != nil && r.Empty.Code != tc.empty) {
				t.Fatalf("empty = %+v, want %q", r.Empty, tc.empty)
			}
		})
	}
}

func TestCounterRotatesPerGroup(t *testing.T) {
	c := planner.NewCounter()
	p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{{Name: "a", Shape: shape.OpenAIChat}}, Keys: keys("k1", "k2", "k3")}}
	var firsts []string
	for range 4 {
		r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "m"}, p, c)
		firsts = append(firsts, r.Candidates[0].Key.Name)
	}
	if got := strings.Join(firsts, ","); got != "k1,k2,k3,k1" {
		t.Fatalf("first keys = %s", got)
	}
	if c.Next("other") != 0 {
		t.Fatal("groups share a counter")
	}
}

var now = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func TestKeyStatesExcludeKeys(t *testing.T) {
	chat := planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}
	chatB := planner.Endpoint{ID: "ep_b", Name: "b", Shape: shape.OpenAIChat, Renames: map[string]string{"glm": "glm-b"}}
	soon, later := now.Add(30*time.Second), now.Add(5*time.Minute)
	k := func(name string, f func(*planner.Key)) planner.Key {
		key := planner.Key{ID: "uk_" + name, Name: name}
		f(&key)
		return key
	}
	disabled := k("off", func(k *planner.Key) { k.Disabled = true })
	invalid := k("bad", func(k *planner.Key) { k.Invalid = true })
	cooling := k("cool", func(k *planner.Key) { k.CoolingUntil = later })
	cooled := k("was", func(k *planner.Key) { k.CoolingUntil = now.Add(-time.Second) })
	modelCool := k("mc", func(k *planner.Key) { k.ModelCooling = map[string]time.Time{"glm": soon} })
	ok := k("ok", func(*planner.Key) {})
	gap := k("gap", func(k *planner.Key) { k.ModelGaps = map[string]time.Time{"glm": later} })
	oldGap := k("old", func(k *planner.Key) { k.ModelGaps = map[string]time.Time{"glm": now} })

	cases := []struct {
		name      string
		eps       []planner.Endpoint
		keys      []planner.Key
		want      string
		skips     string
		empty     planner.EmptyCode
		emptyTill time.Time
	}{
		{"usable keys only", []planner.Endpoint{chat}, []planner.Key{disabled, ok, invalid, cooling, cooled},
			"ok@a:glm was@a:glm", "off:disabled bad:invalid cool:cooling", "", time.Time{}},
		{"model cooling is per wire model", []planner.Endpoint{chat, chatB}, []planner.Key{modelCool},
			"mc@b:glm-b", "mc:cooling_model:glm", "", time.Time{}},
		{"never servable", []planner.Endpoint{chat}, []planner.Key{disabled, invalid},
			"", "off:disabled bad:invalid", planner.NoUsableKey, time.Time{}},
		{"cooling until the earliest end", []planner.Endpoint{chat}, []planner.Key{invalid, cooling, modelCool},
			"", "bad:invalid cool:cooling mc:cooling_model:glm", planner.Cooling, soon},
		{"a Model Gap is per wire model", []planner.Endpoint{chat, chatB}, []planner.Key{gap, oldGap},
			"gap@b:glm-b old@a:glm old@b:glm-b", "gap:model_gap:glm", "", time.Time{}},
		{"every usable key has a Model Gap", []planner.Endpoint{chat}, []planner.Key{disabled, gap},
			"", "off:disabled gap:model_gap:glm", planner.ModelGap, later},
		{"cooling beats a Model Gap", []planner.Endpoint{chat}, []planner.Key{gap, modelCool},
			"", "gap:model_gap:glm mc:cooling_model:glm", planner.Cooling, soon},
		{"keys back from cooling go after the others", []planner.Endpoint{chat},
			[]planner.Key{cooled, k("mcp", func(k *planner.Key) { k.ModelCooling = map[string]time.Time{"glm": now.Add(-time.Minute)} }), ok,
				k("oth", func(k *planner.Key) { k.ModelCooling = map[string]time.Time{"other": now.Add(-time.Minute)} })},
			"ok@a:glm oth@a:glm was@a:glm mcp@a:glm", "", "", time.Time{}},
		{"a past cooling for one wire model ranks only that Endpoint later", []planner.Endpoint{chat, chatB},
			[]planner.Key{k("mcp", func(k *planner.Key) { k.ModelCooling = map[string]time.Time{"glm": now.Add(-time.Minute)} }), ok},
			"mcp@b:glm-b ok@a:glm ok@b:glm-b mcp@a:glm", "", "", time.Time{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: tc.eps, Keys: tc.keys}}
			r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now}, p, planner.Fixed(0))
			if got := order(r); got != tc.want {
				t.Fatalf("order = %q, want %q", got, tc.want)
			}
			var skips []string
			for _, s := range r.Skipped {
				x := s.Key.Name + ":" + string(s.Reason)
				if s.Model != "" {
					x += ":" + s.Model
				}
				skips = append(skips, x)
			}
			if got := strings.Join(skips, " "); got != tc.skips {
				t.Fatalf("skips = %q, want %q", got, tc.skips)
			}
			if tc.empty == "" {
				if r.Empty != nil {
					t.Fatalf("unexpected empty %+v", r.Empty)
				}
				return
			}
			if r.Empty == nil || r.Empty.Code != tc.empty || !r.Empty.Until.Equal(tc.emptyTill) || r.Empty.Message == "" {
				t.Fatalf("empty = %+v, want %s until %v", r.Empty, tc.empty, tc.emptyTill)
			}
		})
	}
}

func TestKnownCarriersGoFirstAndOthersStay(t *testing.T) {
	a := planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}
	b := planner.Endpoint{ID: "ep_b", Name: "b", Shape: shape.OpenAIChat, Renames: map[string]string{"glm": "glm-b"}}
	carrying := func(name string, models ...string) planner.Key {
		k := planner.Key{ID: "uk_" + name, Name: name, Secret: "sk-test-" + name}
		for _, m := range models {
			if k.Carries == nil {
				k.Carries = map[string]bool{}
			}
			k.Carries[m] = true
		}
		return k
	}
	back := func(k planner.Key) planner.Key { k.CoolingUntil = now.Add(-time.Second); return k }
	cases := []struct {
		name string
		eps  []planner.Endpoint
		keys []planner.Key
		rot  planner.Rotation
		want string
	}{
		{"no lists: round-robin order", []planner.Endpoint{a}, []planner.Key{carrying("k1"), carrying("k2"), carrying("k3")}, planner.Fixed(1),
			"k2@a:glm k3@a:glm k1@a:glm"},
		{"carriers first, rotation kept within each group", []planner.Endpoint{a},
			[]planner.Key{carrying("k1", "glm"), carrying("k2", "other"), carrying("k3", "glm"), carrying("k4")}, planner.Fixed(2),
			"k3@a:glm k1@a:glm k4@a:glm k2@a:glm"},
		{"carrying is judged per Endpoint on the wire model", []planner.Endpoint{a, b},
			[]planner.Key{carrying("k1", "glm"), carrying("k2", "glm-b")}, planner.Fixed(0),
			"k1@a:glm k2@b:glm-b k1@b:glm-b k2@a:glm"},
		{"healthy keys before carriers back from cooling", []planner.Endpoint{a},
			[]planner.Key{back(carrying("k1", "glm")), carrying("k2"), carrying("k3", "glm"), back(carrying("k4")),
				carrying("k5", "glm"), back(carrying("k6", "glm")), carrying("k7")}, planner.Fixed(2),
			"k3@a:glm k5@a:glm k7@a:glm k2@a:glm k6@a:glm k1@a:glm k4@a:glm"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: tc.eps, Keys: tc.keys}}
			r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now}, p, tc.rot)
			if got := order(r); got != tc.want {
				t.Fatalf("order = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestAnEndpointGapSkipsTheKeyOnThatEndpointOnly(t *testing.T) {
	a := planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}
	b := planner.Endpoint{ID: "ep_b", Name: "b", Shape: shape.OpenAIChat}
	ks := keys("k1", "k2")
	ks[0].EndpointGaps = map[string]bool{"ep_b": true}
	p := planner.Provider{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{b, a}, Keys: ks}
	r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "m"}, []planner.Provider{p}, planner.Fixed(0))
	if got := order(r); got != "k1@a:m k2@b:m k2@a:m" {
		t.Fatalf("order = %q", got)
	}
	if len(r.Skipped) != 1 || r.Skipped[0].Reason != planner.SkipEndpointGap || r.Skipped[0].Key.Name != "k1" || r.Skipped[0].Endpoint.Name != "b" {
		t.Fatalf("skipped = %+v", r.Skipped)
	}

	ks = keys("k1")
	ks[0].EndpointGaps = map[string]bool{"ep_b": true, "ep_a": true}
	p.Keys = ks
	r = planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "m"}, []planner.Provider{p}, planner.Fixed(0))
	if r.Empty == nil || r.Empty.Code != planner.NoUsableKey || !strings.Contains(r.Empty.Message, "Endpoint Gap") || len(r.Skipped) != 2 {
		t.Fatalf("empty = %+v skipped %+v", r.Empty, r.Skipped)
	}
	ks[0].Disabled = true
	r = planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "m", Now: time.Now()}, []planner.Provider{p}, planner.Fixed(0))
	if len(r.Skipped) != 1 || r.Skipped[0].Reason != planner.SkipDisabled {
		t.Fatalf("skipped = %+v", r.Skipped)
	}
}
