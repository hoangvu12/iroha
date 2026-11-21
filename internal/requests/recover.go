package requests

import (
	"context"
	"database/sql"
	"log/slog"

	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

var KindInterrupted = logs.NewKind("request.interrupted", "At startup: a Request the previous run of Iroha never finished (crash or forced stop) was marked interrupted. Linked to the Request and Provider.")

const interruptedMessage = "Iroha stopped (crash or forced restart) before this Request finished; the Caller's connection was lost."

func closeInterrupted(ctx context.Context, db *store.DB, log *slog.Logger) error {
	type left struct{ id, provider string }
	var found []left
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id, provider_handle FROM requests WHERE state = ?`, StateInProgress)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l left
			if err := rows.Scan(&l.id, &l.provider); err != nil {
				rows.Close()
				return err
			}
			found = append(found, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE requests SET state = ?, error_code = 'interrupted', error_message = ?,
			provider_handle = coalesce(nullif(provider_handle, ''), (SELECT a.provider_handle FROM attempts a WHERE a.request_id = requests.id ORDER BY a.seq DESC LIMIT 1), ''),
			provider_id = coalesce(nullif(provider_id, ''), (SELECT a.provider_id FROM attempts a WHERE a.request_id = requests.id ORDER BY a.seq DESC LIMIT 1), '')
			WHERE state = ?`, StateInterrupted, interruptedMessage, StateInProgress)
		if err != nil {
			return err
		}
		for i, l := range found {
			if l.provider == "" {
				_ = tx.QueryRowContext(ctx, `SELECT provider_handle FROM requests WHERE id = ?`, l.id).Scan(&found[i].provider)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, l := range found {
		attrs := []any{logs.Kind(KindInterrupted), logs.Request(l.id)}
		if l.provider != "" {
			attrs = append(attrs, logs.Provider(l.provider))
		}
		log.Warn("a Request was interrupted by the previous stop", attrs...)
	}
	return nil
}
