package models

import (
	"context"
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/modelmeta"
)

const (
	ModelsDevOK          = "ok"
	ModelsDevStale       = "stale"
	ModelsDevUnavailable = "unavailable"
	ModelsDevOff         = "off"
)

type layers struct {
	overrides, reported, external modelmeta.Facts
}

func entryLayers(brand, reported, overrides, external, externalBrand string) layers {
	l := layers{overrides: modelmeta.Parse(overrides)}
	if reported != "" {
		l.reported = modelmeta.Normalize(json.RawMessage(reported))
	}
	if externalBrand == brand {
		l.external = modelmeta.Parse(external)
	}
	return l
}

func (l layers) served() modelmeta.Facts {
	return modelmeta.Served(modelmeta.Resolve(l.overrides, l.reported, l.external))
}

type Metadata map[string]modelmeta.Facts

func (m Metadata) Of(model string) modelmeta.Facts {
	if f, ok := m[model]; ok {
		return f
	}
	return modelmeta.Served(modelmeta.Facts{})
}

func (s *Store) Metadata(ctx context.Context, providerID string) (Metadata, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.model, m.reported, m.overrides, m.external, m.external_brand, p.models_dev_brand
		FROM provider_models m JOIN providers p ON p.id = m.provider_id WHERE m.provider_id = ?`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := Metadata{}
	for rows.Next() {
		var model, reported, overrides, external, externalBrand, brand string
		if err := rows.Scan(&model, &reported, &overrides, &external, &externalBrand, &brand); err != nil {
			return nil, err
		}
		out[model] = entryLayers(brand, reported, overrides, external, externalBrand).served()
	}
	return out, rows.Err()
}

func (s *Store) supplement(ctx context.Context, providerID string, only []string) (string, error) {
	if !s.meta.Enabled() {
		return ModelsDevOff, nil
	}
	cat, err := s.meta.Catalog(ctx)
	if cat == nil {
		return ModelsDevUnavailable, nil
	}
	outcome := ModelsDevOK
	if err != nil {
		outcome = ModelsDevStale
	}
	return outcome, s.db.Tx(ctx, func(tx *sql.Tx) error {
		var brand string
		if err := tx.QueryRowContext(ctx, `SELECT models_dev_brand FROM providers WHERE id = ?`, providerID).Scan(&brand); err != nil {
			return err
		}
		q := `SELECT id, model, external, external_brand FROM provider_models WHERE provider_id = ?`
		args := []any{providerID}
		if only != nil {
			if len(only) == 0 {
				return nil
			}
			q += ` AND model IN (?` + strings.Repeat(", ?", len(only)-1) + `)`
			for _, m := range only {
				args = append(args, m)
			}
		}
		rows, err := tx.QueryContext(ctx, q, args...)
		if err != nil {
			return err
		}
		type change struct{ id, external string }
		var changes []change
		for rows.Next() {
			var id, model, external, externalBrand string
			if err := rows.Scan(&id, &model, &external, &externalBrand); err != nil {
				rows.Close()
				return err
			}
			if f := cat.Lookup(brand, model).String(); f != external || externalBrand != brand {
				changes = append(changes, change{id, f})
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, c := range changes {
			if _, err := tx.ExecContext(ctx, `UPDATE provider_models SET external = ?, external_brand = ? WHERE id = ?`, c.external, brand, c.id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) supplementAfterChange(ctx context.Context, p provRef, models []string) {
	if _, err := s.supplement(context.WithoutCancel(ctx), p.id, models); err != nil {
		s.log.Error("models.dev lookup after a model change failed", logs.Kind(logs.KindGeneric), logs.Provider(p.handle), "err", err.Error())
	}
}

func (s *Store) lookUp(ctx context.Context, p provRef, m Model) (Model, error) {
	s.supplementAfterChange(ctx, p, []string{m.Model})
	out, ok, err := readEntry(ctx, s.db, p.id, m.Model, s.clock.Now())
	if err != nil || !ok {
		return m, err
	}
	return out, nil
}

const (
	maxTokens = 1 << 40
	maxWords  = 16
)

var wordPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,31}$`)

const overridesHint = "Send metadata as the fields Callers' model lists show, e.g. {\"context_length\": 1000000, \"max_output_tokens\": 64000, " +
	"\"architecture\": {\"input_modalities\": [\"text\", \"image\"]}, \"reasoning\": true, \"reasoning_levels\": [\"low\", \"high\"], \"chat\": \"ok\"}; {} clears every override."

func checkOverrides(f modelmeta.Facts) (modelmeta.Facts, error) {
	for name, v := range map[string]*int64{"context_length": f.ContextLength, "max_input_tokens": f.MaxInputTokens, "max_output_tokens": f.MaxOutputTokens} {
		if v != nil && (*v <= 0 || *v > maxTokens) {
			return f, api.BadRequest(overridesHint, "metadata.%s must be a positive number of tokens.", name)
		}
	}
	words := func(name string, in []string) ([]string, error) {
		var out []string
		if len(in) > maxWords {
			return nil, api.BadRequest(overridesHint, "metadata.%s has more than %d entries.", name, maxWords)
		}
		for _, w := range in {
			w = strings.ToLower(strings.TrimSpace(w))
			if !wordPattern.MatchString(w) {
				return nil, api.BadRequest(overridesHint, "metadata.%s: %q is not a word such as \"text\" or \"high\".", name, w)
			}
			if !contains(out, w) {
				out = append(out, w)
			}
		}
		return out, nil
	}
	var err error
	if a := f.Architecture; a != nil {
		in, out := a.InputModalities, a.OutputModalities
		if in, err = words("architecture.input_modalities", in); err != nil {
			return f, err
		}
		if out, err = words("architecture.output_modalities", out); err != nil {
			return f, err
		}
		f.Architecture = nil
		if in != nil || out != nil {
			f.Architecture = &modelmeta.Architecture{InputModalities: in, OutputModalities: out}
		}
	}
	if f.ReasoningLevels, err = words("reasoning_levels", f.ReasoningLevels); err != nil {
		return f, err
	}
	if f.Reasoning != nil && !*f.Reasoning && len(f.ReasoningLevels) > 0 {
		return f, api.BadRequest(overridesHint, "metadata says reasoning false but lists reasoning_levels.")
	}
	switch f.Chat {
	case "", modelmeta.ChatOK, modelmeta.ChatUnsupported:
	default:
		return f, api.BadRequest(overridesHint, "metadata.chat must be ok or unsupported, not %q.", f.Chat)
	}
	return f, nil
}

func (m *Model) setMetadata(l layers) {
	m.Metadata = l.served()
	m.Overrides, m.Reported, m.ModelsDev = l.overrides, l.reported, l.external
}
