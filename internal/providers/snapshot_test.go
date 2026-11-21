package providers

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/planner"
)

func TestSnapshotsWrittenBeforeASettingExistedDecodeToItsDefault(t *testing.T) {
	var p providerSnapshot
	if err := json.Unmarshal([]byte(`{"id":"pr_1","handle":"acme"}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.Discovery != DiscoveryProvider || p.Affinity != AffinityOn {
		t.Fatalf("provider snapshot = %+v", p)
	}
	var e endpointSnapshot
	if err := json.Unmarshal([]byte(`{"id":"ep_1","url":"https://api.example.com/v1"}`), &e); err != nil {
		t.Fatal(err)
	}
	if e.AuthStyle != string(planner.AuthBearer) {
		t.Fatalf("endpoint snapshot = %+v", e)
	}
}

func TestProviderSnapshotsLeaveDefaultsOutAndKeepOtherValues(t *testing.T) {
	b, err := json.Marshal(&providerSnapshot{ID: "pr_1", Discovery: DiscoveryProvider, Affinity: AffinityOn})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "discovery") || strings.Contains(string(b), "affinity") {
		t.Fatalf("defaults written: %s", b)
	}
	b, _ = json.Marshal(&providerSnapshot{ID: "pr_1", Discovery: DiscoveryKey, Affinity: AffinityOff})
	var back providerSnapshot
	if err := json.Unmarshal(b, &back); err != nil || back.Discovery != DiscoveryKey || back.Affinity != AffinityOff {
		t.Fatalf("round trip of %s = %+v, %v", b, back, err)
	}
}
