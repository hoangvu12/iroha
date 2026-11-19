package store_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/store"
)

// Guards the naming convention parallel tickets rely on: every file is
// <ticket>_<seq>_<slug>.sql and no two share a (ticket, seq).
func TestMigrationFilesFollowTheNamingConvention(t *testing.T) {
	ms, err := store.Migrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) == 0 {
		t.Fatal("no migrations embedded")
	}
	for i := 1; i < len(ms); i++ {
		a, b := ms[i-1], ms[i]
		if a.Ticket > b.Ticket || (a.Ticket == b.Ticket && a.Seq >= b.Seq) {
			t.Fatalf("migrations out of order: %s before %s", a.Name, b.Name)
		}
	}
}
