package requests

import (
	"context"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/store"
)

func ServedModels(ctx context.Context, db *store.DB, handle string, since time.Time) (map[string]int, error) {
	rows, err := db.QueryContext(ctx, `SELECT model, wire_model, pool, count(*) FROM requests
		WHERE provider_handle = ? AND started_at >= ? AND status >= 200 AND status < 300
		GROUP BY model, wire_model, pool`, handle, store.Millis(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var model, wire, pool string
		var n int
		if err := rows.Scan(&model, &wire, &pool, &n); err != nil {
			return nil, err
		}
		m := strings.TrimPrefix(model, handle+"/")
		if pool != "" && wire != "" {
			m = wire
		}
		if m != "" {
			out[m] += n
		}
	}
	return out, rows.Err()
}
