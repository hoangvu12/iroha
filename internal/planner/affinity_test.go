package planner_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
)

var chatEP = planner.Endpoint{ID: "ep_a", Name: "a", Shape: shape.OpenAIChat}

func manyKeys(n int) []planner.Key {
	var names []string
	for i := range n {
		names = append(names, fmt.Sprintf("k%02d", i))
	}
	return keys(names...)
}

// keyOrder is the plan's keys in order, each once.
func keyOrder(r planner.Result) []string {
	var out []string
	for _, c := range r.Candidates {
		if !slices.Contains(out, c.Key.Name) {
			out = append(out, c.Key.Name)
		}
	}
	return out
}

func planFor(conv string, ps []planner.Provider, rot planner.Rotation) planner.Result {
	return planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now, Affinity: conv}, ps, rot)
}

func one(ks []planner.Key) []planner.Provider {
	return []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{chatEP}, Keys: ks}}
}

// A conversation gets the same order on every Request, whatever the
// round-robin counter says; other conversations get other first keys.
func TestAConversationKeepsItsKeyOrder(t *testing.T) {
	ks := manyKeys(8)
	base := keyOrder(planFor("conv-1", one(ks), planner.Fixed(0)))
	if len(base) != 8 {
		t.Fatalf("order = %v", base)
	}
	for rot := range 5 {
		if got := keyOrder(planFor("conv-1", one(ks), planner.Fixed(rot))); !slices.Equal(got, base) {
			t.Fatalf("rotation %d changed the order: %v vs %v", rot, got, base)
		}
	}
	firsts := map[string]bool{}
	for i := range 40 {
		firsts[keyOrder(planFor(fmt.Sprintf("conv-%d", i), one(ks), planner.Fixed(0)))[0]] = true
	}
	if len(firsts) < 5 {
		t.Fatalf("40 conversations used only %d first keys", len(firsts))
	}
	// Without a conversation, round-robin as before.
	if got := order(planFor("", one(keys("k1", "k2", "k3")), planner.Fixed(1))); got != "k2@a:glm k3@a:glm k1@a:glm" {
		t.Fatalf("round-robin = %q", got)
	}
}

// A key that drops out (cooling, invalid, disabled, removed) moves only its
// own conversations, each to its own second key, and they return when it is
// usable again.
func TestAKeyDroppingOutMovesOnlyItsConversationsToTheirSecondKey(t *testing.T) {
	ks := manyKeys(6)
	drops := map[string]func(*planner.Key){
		"cooling":  func(k *planner.Key) { k.CoolingUntil = now.Add(time.Minute) },
		"invalid":  func(k *planner.Key) { k.Invalid = true },
		"disabled": func(k *planner.Key) { k.Disabled = true },
		"model cooling": func(k *planner.Key) {
			k.ModelCooling = map[string]time.Time{"glm": now.Add(time.Minute)}
		},
	}
	for name, drop := range drops {
		t.Run(name, func(t *testing.T) {
			for i := range 60 {
				conv := fmt.Sprintf("conv-%d", i)
				before := keyOrder(planFor(conv, one(ks), planner.Fixed(0)))
				changed := slices.Clone(ks)
				victim := slices.IndexFunc(changed, func(k planner.Key) bool { return k.Name == "k03" })
				drop(&changed[victim])
				after := keyOrder(planFor(conv, one(changed), planner.Fixed(i)))
				want := slices.DeleteFunc(slices.Clone(before), func(n string) bool { return n == "k03" })
				if !slices.Equal(after, want) {
					t.Fatalf("%s: %v became %v, want %v", conv, before, after, want)
				}
				// Removed altogether: the same.
				removed := slices.Delete(slices.Clone(ks), victim, victim+1)
				if got := keyOrder(planFor(conv, one(removed), planner.Fixed(0))); !slices.Equal(got, want) {
					t.Fatalf("%s removed: %v, want %v", conv, got, want)
				}
				// Back: the order it had.
				if got := keyOrder(planFor(conv, one(ks), planner.Fixed(3))); !slices.Equal(got, before) {
					t.Fatalf("%s did not return: %v", conv, got)
				}
			}
		})
	}
}

// Affinity orders keys within the groups planTier already forms: healthy
// before back-from-cooling, carriers before the others; inside each group
// the keys keep the conversation's order.
func TestAffinityOrdersWithinHealthAndCarrierGroups(t *testing.T) {
	ks := manyKeys(10)
	for i := range 30 {
		conv := fmt.Sprintf("conv-%d", i)
		base := keyOrder(planFor(conv, one(ks), planner.Fixed(0)))
		grouped := slices.Clone(ks)
		back := map[string]bool{"k01": true, "k04": true, "k07": true}
		carrier := map[string]bool{"k02": true, "k04": true, "k08": true, "k09": true}
		for j := range grouped {
			k := &grouped[j]
			if back[k.Name] {
				k.CoolingUntil = now.Add(-time.Second)
			}
			if carrier[k.Name] {
				k.Carries = map[string]bool{"glm": true}
			}
		}
		got := keyOrder(planFor(conv, one(grouped), planner.Fixed(0)))
		rank := func(n string) int {
			r := 0
			if back[n] {
				r += 2
			}
			if !carrier[n] {
				r++
			}
			return r
		}
		want := slices.Clone(base)
		slices.SortStableFunc(want, func(a, b string) int { return rank(a) - rank(b) })
		if !slices.Equal(got, want) {
			t.Fatalf("%s: got %v, want %v (base %v)", conv, got, want, base)
		}
	}
}

// Every key goes on every Endpoint of the tier it may use, Endpoints in
// configured order; the Caller's Shape stays the first tier; exclusions
// and skips are as without affinity.
func TestAffinityKeepsEndpointsTiersAndExclusions(t *testing.T) {
	b := planner.Endpoint{ID: "ep_b", Name: "b", Shape: shape.OpenAIChat, Renames: map[string]string{"glm": "glm-b"}}
	m := planner.Endpoint{ID: "ep_m", Name: "m", Shape: shape.AnthropicMessages}
	ks := keys("k1", "k2", "k3")
	ks[1].Disabled = true
	ks[2].Endpoints = []string{"ep_b"}
	p := []planner.Provider{{ID: "p", Handle: "p", Endpoints: []planner.Endpoint{m, chatEP, b}, Keys: ks}}
	r := planner.Plan(planner.Request{Shape: shape.OpenAIChat, Model: "glm", Now: now, Affinity: "c", Translate: []shape.Shape{shape.AnthropicMessages}}, p, planner.Fixed(0))
	got := order(r)
	if got != "k1@a:glm k1@b:glm-b k3@b:glm-b" && got != "k3@b:glm-b k1@a:glm k1@b:glm-b" {
		t.Fatalf("order = %q", got)
	}
	if len(r.Skipped) != 1 || r.Skipped[0].Key.Name != "k2" || r.Skipped[0].Reason != planner.SkipDisabled {
		t.Fatalf("skipped = %+v", r.Skipped)
	}
}

// Pools keep member order; each member ranks its own keys, and a Provider
// with affinity off keeps round-robin.
func TestPoolsKeepMemberOrderAndEachMemberItsOwnSwitch(t *testing.T) {
	ps := []planner.Provider{
		{ID: "p", Handle: "p", Model: "glm-4.6", Endpoints: []planner.Endpoint{chatEP}, Keys: keys("p1", "p2", "p3")},
		{ID: "q", Handle: "q", Model: "glm", Endpoints: []planner.Endpoint{chatEP}, Keys: keys("q1", "q2", "q3"), AffinityOff: true},
	}
	for i := range 20 {
		conv := fmt.Sprintf("conv-%d", i)
		got := keyOrder(planFor(conv, ps, planner.Fixed(1)))
		if len(got) != 6 || !strings.HasPrefix(got[0], "p") || !strings.HasPrefix(got[2], "p") {
			t.Fatalf("member order lost: %v", got)
		}
		if again := keyOrder(planFor(conv, ps, planner.Fixed(2))); !slices.Equal(again[:3], got[:3]) {
			t.Fatalf("member p is not ordered for the conversation: %v vs %v", got, again)
		}
		if strings.Join(got[3:], " ") != "q2 q3 q1" {
			t.Fatalf("member q (affinity off) is not round-robin: %v", got[3:])
		}
	}
}

// With many conversations, first choices spread over the keys about as
// evenly as round-robin does.
func TestLoadStillSpreadsAcrossKeysWithManyConversations(t *testing.T) {
	const n, convs = 12, 24000
	ks := manyKeys(n)
	count := map[string]int{}
	for i := range convs {
		count[planFor(fmt.Sprintf("caller-%d/conv-%d", i%7, i), one(ks), planner.Fixed(0)).Candidates[0].Key.Name]++
	}
	mean := convs / n
	for _, k := range ks {
		if c := count[k.Name]; c < mean*85/100 || c > mean*115/100 {
			t.Fatalf("key %s is first for %d of %d conversations (mean %d): %v", k.Name, c, convs, mean, count)
		}
	}
}
