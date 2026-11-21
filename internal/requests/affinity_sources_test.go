package requests_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/affinity"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestAffinitySourcesAreAffinitysList(t *testing.T) {
	var want []string
	for _, s := range affinity.Sources {
		want = append(want, string(s))
	}
	f, _ := reflect.TypeOf(requests.Affinity{}).FieldByName("Source")
	if got := f.Tag.Get("enum"); got != strings.Join(want, ",") {
		t.Errorf("Affinity.Source enum %q, want %q", got, strings.Join(want, ","))
	}
	srv := testkit.Start(t)
	for _, s := range want {
		srv.Admin.Get("/api/requests/stats?affinity_source=" + s).Expect(200)
	}
	srv.Admin.Get("/api/requests/stats?affinity_source=somewhere").Expect(400)
}
