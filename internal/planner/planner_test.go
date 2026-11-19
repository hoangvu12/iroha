package planner_test

import (
	"fmt"
	"strings"
	"testing"

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
