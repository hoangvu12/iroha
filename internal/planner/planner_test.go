package planner_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
)

// order renders a plan as "key@endpoint:model" items.
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
		empty     string
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
		empty string
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
				skips = append(skips, s.Key.Name+":"+s.Reason)
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
	cooled := k("was", func(k *planner.Key) { k.CoolingUntil = now.Add(-time.Second) }) // past cooling: usable
	modelCool := k("mc", func(k *planner.Key) { k.ModelCooling = map[string]time.Time{"glm": soon} })
	ok := k("ok", func(*planner.Key) {})

	cases := []struct {
		name      string
		eps       []planner.Endpoint
		keys      []planner.Key
		want      string
		skips     string
		empty     string
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
				x := s.Key.Name + ":" + s.Reason
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
