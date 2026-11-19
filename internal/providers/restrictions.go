package providers

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
)

// Restricting an Upstream Key to some Endpoints (upstream_key_endpoints).
// A key without rows may use every Endpoint of its Provider. Audit
// snapshots of a key hold the Endpoint IDs, so renaming an Endpoint never
// makes a key's Audit Entry conflict.

// pairs runs query (key ID, value) and groups the values by key.
func pairs(ctx context.Context, q queryer, query string, args ...any) (map[string][]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = append(out[k], v)
	}
	return out, rows.Err()
}

const restrictionOrder = ` ORDER BY e.created_at, e.rowid`

// keyEndpointIDs maps each restricted key of a Provider to its Endpoint IDs.
func keyEndpointIDs(ctx context.Context, q queryer, providerID string) (map[string][]string, error) {
	return pairs(ctx, q, `SELECT ke.key_id, e.id FROM upstream_key_endpoints ke JOIN endpoints e ON e.id = ke.endpoint_id
		WHERE e.provider_id = ?`+restrictionOrder, providerID)
}

// keyEndpointNamesByKey maps each restricted key of a Provider to its Endpoint names.
func keyEndpointNamesByKey(ctx context.Context, q queryer, providerID string) (map[string][]string, error) {
	return pairs(ctx, q, `SELECT ke.key_id, e.name FROM upstream_key_endpoints ke JOIN endpoints e ON e.id = ke.endpoint_id
		WHERE e.provider_id = ?`+restrictionOrder, providerID)
}

// keyEndpointNames lists the names of the Endpoints key id is restricted to.
func keyEndpointNames(ctx context.Context, q queryer, id string) ([]string, error) {
	m, err := pairs(ctx, q, `SELECT ke.key_id, e.name FROM upstream_key_endpoints ke JOIN endpoints e ON e.id = ke.endpoint_id
		WHERE ke.key_id = ?`+restrictionOrder, id)
	if err != nil {
		return nil, err
	}
	if m[id] == nil {
		return []string{}, nil
	}
	return m[id], nil
}

// keyEndpointIDsOf lists, sorted, the Endpoint IDs key id is restricted to.
func keyEndpointIDsOf(ctx context.Context, q audit.Querier, id string) ([]string, error) {
	var list sql.NullString
	err := q.QueryRowContext(ctx, `SELECT group_concat(endpoint_id, ',') FROM
		(SELECT endpoint_id FROM upstream_key_endpoints WHERE key_id = ? ORDER BY endpoint_id)`, id).Scan(&list)
	if err != nil || list.String == "" {
		return nil, err
	}
	out := strings.Split(list.String, ",")
	slices.Sort(out)
	return out, nil
}

// writeKeyEndpoints replaces key id's restriction with endpointIDs, which
// must be Endpoints of providerID.
func writeKeyEndpoints(ctx context.Context, q *sql.Tx, providerID, id string, endpointIDs []string) error {
	for _, e := range endpointIDs {
		var owner string
		err := q.QueryRowContext(ctx, `SELECT provider_id FROM endpoints WHERE id = ?`, e).Scan(&owner)
		if err != nil || owner != providerID {
			return api.Conflict("endpoint_missing", "Revert the Audit Entry that deleted that Endpoint first, or restrict the key to existing Endpoints.",
				"Endpoint %s no longer exists on this Provider.", e)
		}
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM upstream_key_endpoints WHERE key_id = ?`, id); err != nil {
		return err
	}
	for _, e := range endpointIDs {
		if _, err := q.ExecContext(ctx, `INSERT INTO upstream_key_endpoints (key_id, endpoint_id) VALUES (?, ?)`, id, e); err != nil {
			return err
		}
	}
	return nil
}

// resolveEndpoints resolves Endpoint names or IDs of Provider p, sorted
// and without duplicates.
func resolveEndpoints(ctx context.Context, q queryer, p ref, refs []string) ([]string, error) {
	out := make([]string, 0, len(refs))
	for _, r := range refs {
		id, err := resolveChild(ctx, q, "endpoints", "Endpoint", "endpoints", p, strings.TrimSpace(r))
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	slices.Sort(out)
	return slices.Compact(out), nil
}

// releaseEndpoint removes Endpoint id from the restriction of every key of
// Provider p, tracking each key. A key restricted to that Endpoint alone
// would be left with nowhere to go, so the change is refused instead.
func releaseEndpoint(m *audit.Mutation, p ref, id string) error {
	rows, err := m.Tx.QueryContext(m.Ctx, `SELECT k.id, k.name, (SELECT count(*) FROM upstream_key_endpoints x WHERE x.key_id = k.id)
		FROM upstream_key_endpoints ke JOIN upstream_keys k ON k.id = ke.key_id WHERE ke.endpoint_id = ? ORDER BY k.created_at, k.rowid`, id)
	if err != nil {
		return err
	}
	var keys, alone []string
	for rows.Next() {
		var kid, name string
		var n int
		if err := rows.Scan(&kid, &name, &n); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, kid)
		if n == 1 {
			alone = append(alone, name)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(alone) > 0 {
		return api.Conflict("endpoint_in_use",
			fmt.Sprintf("Restrict those keys to other Endpoints (PATCH /api/providers/%s/keys/<key> {\"endpoints\": [...]}, [] for all) or delete them, then retry.", p.handle),
			"Upstream Keys %s may use only this Endpoint.", strings.Join(alone, ", ")).
			WithDetails(map[string]any{"upstream_keys": alone})
	}
	for _, kid := range keys {
		if err := m.Track(KeyResource, kid); err != nil {
			return err
		}
	}
	_, err = m.Tx.ExecContext(m.Ctx, `DELETE FROM upstream_key_endpoints WHERE endpoint_id = ?`, id)
	return err
}
