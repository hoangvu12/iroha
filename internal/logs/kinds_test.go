package logs_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// Every kind of event the spec names is registered, listed in the served
// skill, and readable through the logs API by its Request and Provider.
func TestEveryEventKindIsDocumentedAndLinkable(t *testing.T) {
	srv := testkit.Start(t)
	skill := srv.Anon.Get("/skill.md").Expect(200).Text()
	for _, k := range []string{"attempt", "request", "request.interrupted", "rule.match", "key.state", "model_gap",
		"discovery", "job.run", "config.change", "startup", "shutdown"} {
		if !strings.Contains(skill, "- `"+k+"`: ") {
			t.Errorf("the skill does not list kind %s", k)
		}
	}

	// The shared kinds that later work emits keep their links.
	log := srv.App.Logger()
	for _, k := range []logs.EventKind{logs.KindRuleMatch, logs.KindKeyState, logs.KindModelGap, logs.KindDiscovery, logs.KindJobRun} {
		log.Warn("example", logs.Kind(k), logs.Request("req_x"), logs.Provider("acme"), "upstream_key", "key-1")
		ev := srv.Logs("kind=" + k.Name + "&request_id=req_x&provider=acme&level=warn")
		if len(ev) != 1 || ev[0].Kind != k.Name || ev[0].Attrs["upstream_key"] != "key-1" {
			t.Errorf("%s: %+v", k.Name, ev)
		}
	}
}
