// Package settings is Iroha's runtime configuration that is not a record of
// its own: retention periods today, more later. Each setting is declared in
// the package that reads it, has a built-in default, and is changed through
// /api/settings with the audit conventions (dry run, Audit Entries, revert).
//
//	var HistoryDays = settings.NewInt(settings.Int{Name: "retention.history_days", Default: 30, Min: 1, Max: 3650, ...})
//	days, err := HistoryDays.Get(ctx, db)
//
// A setting that takes one of a few words is a Choice:
//
//	var Experiment = settings.NewChoice(settings.Choice{Name: "affinity.experiment", Choices: []string{"off", "half"}, Default: "off", ...})
package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/store"
)

// Int declares an integer setting.
type Int struct {
	Name        string // dotted, e.g. retention.history_days
	Description string
	Unit        string // e.g. days
	Default     int64
	Min, Max    int64
}

// Choice declares a setting that takes one of a few words.
type Choice struct {
	Name        string
	Description string
	Choices     []string
	Default     string
}

// def is one registered setting, of either kind.
type def struct {
	name, description, unit string
	integer                 *Int
	choice                  *Choice
}

var (
	registryMu sync.Mutex
	registry   = map[string]*def{}
)

// NewInt registers an integer setting. Call it from a package-level var; it
// panics on a duplicate name or a default outside [Min, Max].
func NewInt(s Int) *Int {
	if s.Name == "" || s.Description == "" || s.Default < s.Min || s.Default > s.Max {
		panic(fmt.Sprintf("settings: %q needs a name, a description and a default within [min, max]", s.Name))
	}
	p := &s
	register(&def{name: s.Name, description: s.Description, unit: s.Unit, integer: p})
	return p
}

// NewChoice registers a setting taking one of s.Choices. Call it from a
// package-level var; it panics on a duplicate name or a default that is not
// a choice.
func NewChoice(s Choice) *Choice {
	if s.Name == "" || s.Description == "" || !slices.Contains(s.Choices, s.Default) {
		panic(fmt.Sprintf("settings: %q needs a name, a description and a default among its choices", s.Name))
	}
	p := &s
	register(&def{name: s.Name, description: s.Description, choice: p})
	return p
}

func register(d *def) {
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, ok := registry[d.name]; ok {
		panic(fmt.Sprintf("settings: %q registered twice", d.name))
	}
	registry[d.name] = d
}

func lookup(name string) (*def, bool) {
	registryMu.Lock()
	defer registryMu.Unlock()
	s, ok := registry[name]
	return s, ok
}

func all() []*def {
	registryMu.Lock()
	defer registryMu.Unlock()
	out := make([]*def, 0, len(registry))
	for _, s := range registry {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b *def) int { return strings.Compare(a.name, b.name) })
	return out
}

// Get returns the setting's current value: the Owner's, else the default.
func (s *Choice) Get(ctx context.Context, q audit.Querier) (string, error) {
	raw, err := stored(ctx, q, s.Name)
	if err != nil || raw == nil {
		return s.Default, err
	}
	var v string
	if json.Unmarshal(raw, &v) != nil || !slices.Contains(s.Choices, v) {
		return s.Default, nil // a value this version cannot read: fall back
	}
	return v, nil
}

func (d *def) defaultValue() json.RawMessage {
	if d.choice != nil {
		b, _ := json.Marshal(d.choice.Default)
		return b
	}
	return d.integer.encode(d.integer.Default)
}

// parse validates a value sent by an agent and returns it in stored form.
func (d *def) parse(raw json.RawMessage) (json.RawMessage, error) {
	if d.integer != nil {
		return d.integer.parse(raw)
	}
	c := d.choice
	quoted := make([]string, len(c.Choices))
	for i, x := range c.Choices {
		quoted[i] = strconv.Quote(x)
	}
	hint := fmt.Sprintf(`Send {"value": %s}.`, strings.Join(quoted, " or "))
	var v string
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil || !slices.Contains(c.Choices, v) {
		return nil, api.BadRequest(hint, "%s takes one of %s, not %s.", c.Name, strings.Join(c.Choices, ", "), string(raw))
	}
	b, _ := json.Marshal(v)
	return b, nil
}

// Get returns the setting's current value: the Owner's, else the default.
func (s *Int) Get(ctx context.Context, q audit.Querier) (int64, error) {
	raw, err := stored(ctx, q, s.Name)
	if err != nil || raw == nil {
		return s.Default, err
	}
	var v int64
	if err := json.Unmarshal(raw, &v); err != nil {
		return s.Default, nil // a value this version cannot read: fall back
	}
	return v, nil
}

func (s *Int) encode(v int64) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// parse validates a value sent by an agent and returns it in stored form.
func (s *Int) parse(raw json.RawMessage) (json.RawMessage, error) {
	hint := fmt.Sprintf(`Send {"value": <integer from %d to %d>}.`, s.Min, s.Max)
	var v int64
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &v) != nil {
		return nil, api.BadRequest(hint, "%s takes a whole number%s.", s.Name, unitSuffix(s.Unit))
	}
	if v < s.Min || v > s.Max {
		return nil, api.BadRequest(hint, "%s must be between %d and %d%s, not %d.", s.Name, s.Min, s.Max, unitSuffix(s.Unit), v)
	}
	return s.encode(v), nil
}

func unitSuffix(u string) string {
	if u == "" {
		return ""
	}
	return " (" + u + ")"
}

// stored reads the Owner's value of name; nil when the default applies.
func stored(ctx context.Context, q audit.Querier, name string) (json.RawMessage, error) {
	var value string
	err := q.QueryRowContext(ctx, `SELECT value FROM settings WHERE name = ?`, name).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(value), nil
}

// snapshot is what an Audit Entry records of a setting: its value.
type snapshot struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

// Resource is the setting resource of the audit machinery. Every
// registered setting always exists; resetting one restores its default.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "setting", Label: "setting", Plural: "settings", Path: "/api/settings",
	Table: "settings", NameColumn: "name",
	NameOf: func(s snapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, name string) (*snapshot, error) {
		def, ok := lookup(name)
		if !ok {
			return nil, nil
		}
		raw, err := stored(ctx, q, name)
		if err != nil {
			return nil, err
		}
		if raw == nil {
			raw = def.defaultValue()
		}
		return &snapshot{Name: name, Value: raw}, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, name string, s *snapshot) error {
		var value json.RawMessage
		if s != nil {
			value = s.Value
		}
		return write(ctx, tx, name, value)
	},
})

// write stores value for name, or deletes the row when value is nil or the
// default, so an untouched setting follows its built-in default.
func write(ctx context.Context, tx *sql.Tx, name string, value json.RawMessage) error {
	if def, ok := lookup(name); ok && value != nil && string(value) == string(def.defaultValue()) {
		value = nil
	}
	if value == nil {
		_, err := tx.ExecContext(ctx, `DELETE FROM settings WHERE name = ?`, name)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO settings (name, value) VALUES (?, ?)
		ON CONFLICT (name) DO UPDATE SET value = excluded.value`, name, string(value))
	return err
}

// Setting is one setting as the API returns it.
type Setting struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Type        string          `json:"type" enum:"integer,choice"`
	Unit        string          `json:"unit,omitempty"`
	Value       json.RawMessage `json:"value" doc:"The value in effect."`
	Default     json.RawMessage `json:"default" doc:"The built-in value; DELETE /api/settings/{setting} restores it."`
	Min         int64           `json:"min" doc:"For type integer: the lowest value."`
	Max         int64           `json:"max" doc:"For type integer: the highest value."`
	Choices     []string        `json:"choices,omitempty" doc:"For type choice: the values it takes."`
	IsDefault   bool            `json:"is_default" doc:"true while the value is the built-in default. GET /api/audit-entries?resource=setting says who changed what, when."`
}

func view(ctx context.Context, q audit.Querier, def *def) (Setting, error) {
	raw, err := stored(ctx, q, def.name)
	if err != nil {
		return Setting{}, err
	}
	s := Setting{Name: def.name, Description: def.description, Type: "integer", Unit: def.unit, Value: raw, Default: def.defaultValue()}
	if def.integer != nil {
		s.Min, s.Max = def.integer.Min, def.integer.Max
	} else {
		s.Type, s.Choices = "choice", def.choice.Choices
	}
	if raw == nil {
		s.Value, s.IsDefault = s.Default, true
	}
	return s, nil
}

// SettingList is the response of GET /api/settings.
type SettingList struct {
	Settings []Setting `json:"settings"`
}

// SetSetting is the body of PUT /api/settings/{setting}.
type SetSetting struct {
	Value json.RawMessage `json:"value" doc:"The new value, of the setting's type."`
}

// NamedValue is one item of POST /api/settings/bulk.
type NamedValue struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

// SettingResult is the response of a change to one setting.
type SettingResult struct {
	audit.Result
	Setting Setting `json:"setting" doc:"The setting after the change (on a dry run, as it would be)."`
}

func notFound(name string) *api.Error {
	return api.NotFound("List the settings with GET /api/settings.", "There is no setting named %q.", name).
		WithDetails(map[string]string{"resource": "setting", "ref": name})
}

// Routes returns the settings routes.
func Routes(tr *audit.Trail, db *store.DB) []api.Route {
	const tag = "Settings"
	set := func(m *audit.Mutation, in NamedValue) (Setting, error) {
		def, ok := lookup(in.Name)
		if !ok {
			return Setting{}, notFound(in.Name)
		}
		value, err := def.parse(in.Value)
		if err != nil {
			return Setting{}, err
		}
		if err := m.Track(Resource, def.name); err != nil {
			return Setting{}, err
		}
		if err := write(m.Ctx, m.Tx, def.name, value); err != nil {
			return Setting{}, err
		}
		return view(m.Ctx, m.Tx, def)
	}
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/settings", Tag: tag,
			Summary: "List every setting with its value, default and limits",
			Description: "Retention periods live here: retention.history_days (Requests and Attempts), retention.logs_days (log events) and retention.captures_days (captured prompts and responses). The hourly retention job applies them. " +
				"affinity.experiment (off or half) runs the conversation affinity experiment: with half, half the conversations round-robin, so GET /api/requests/stats?affinity=on and ?affinity=control compare the two.",
			Response: SettingList{},
			Handle: func(c *api.Call) (any, error) {
				out := SettingList{Settings: []Setting{}}
				for _, def := range all() {
					s, err := view(c.R.Context(), db, def)
					if err != nil {
						return nil, err
					}
					out.Settings = append(out.Settings, s)
				}
				return out, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/settings/{setting}", Tag: tag,
			Summary:  "Read one setting",
			Response: Setting{},
			Handle: func(c *api.Call) (any, error) {
				def, ok := lookup(c.Path("setting"))
				if !ok {
					return nil, notFound(c.Path("setting"))
				}
				return view(c.R.Context(), db, def)
			},
		},
		{
			Method: http.MethodPut, Path: "/api/settings/{setting}", Tag: tag,
			Summary: "Change a setting",
			Query:   []api.Param{audit.DryRun},
			Request: SetSetting{}, Response: SettingResult{},
			Handle: func(c *api.Call) (any, error) {
				var in SetSetting
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Setting
				res, err := tr.Mutate(c, "setting.update", "Changed", func(m *audit.Mutation) error {
					var err error
					out, err = set(m, NamedValue{Name: c.Path("setting"), Value: in.Value})
					return err
				})
				return SettingResult{Result: res, Setting: out}, err
			},
		},
		{
			Method: http.MethodDelete, Path: "/api/settings/{setting}", Tag: tag,
			Summary:  "Restore a setting's built-in default",
			Query:    []api.Param{audit.DryRun},
			Response: SettingResult{},
			Handle: func(c *api.Call) (any, error) {
				var out Setting
				res, err := tr.Mutate(c, "setting.reset", "Reset", func(m *audit.Mutation) error {
					def, ok := lookup(c.Path("setting"))
					if !ok {
						return notFound(c.Path("setting"))
					}
					var err error
					out, err = set(m, NamedValue{Name: def.name, Value: def.defaultValue()})
					return err
				})
				return SettingResult{Result: res, Setting: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/settings/bulk", Tag: tag,
			Summary:     "Change many settings at once",
			Description: `Body {"items": [{"name": "retention.history_days", "value": 14}, ...]}. Each item is applied or refused on its own.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[NamedValue]{}, Response: audit.BulkResult[Setting]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[NamedValue]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(tr, c, "setting.update", "Changed", in.Items, set)
			},
		},
	}
}
