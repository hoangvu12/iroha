package modelmeta

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Catalog is models.dev, parsed: api.json (models per models.dev provider,
// looked up by a Provider's models.dev brand) and models.json (models keyed
// <maker>/<model>, looked up by the model alone).
type Catalog struct {
	brands map[string]*index // api.json: brand -> its models by ID
	makers *index            // models.json: by "<maker>/<model>"
	plain  *index            // models.json: by the model part alone
}

// Size is the number of models the catalog holds.
func (c *Catalog) Size() int {
	if c == nil {
		return 0
	}
	n := len(c.makers.exact)
	for _, b := range c.brands {
		n += len(b.exact)
	}
	return n
}

// index finds models by exact ID, by ID with dotted versions read as
// dashed, and by bare name for numbered releases. Each key may hold several
// entries; lookups give nothing when they disagree.
type index struct {
	exact    map[string][]Facts
	dashed   map[string][]Facts
	releases map[string][]Facts
}

func newIndex() *index {
	return &index{exact: map[string][]Facts{}, dashed: map[string][]Facts{}, releases: map[string][]Facts{}}
}

func (x *index) add(id string, f Facts) {
	x.exact[id] = append(x.exact[id], f)
	x.dashed[dashed(id)] = append(x.dashed[dashed(id)], f)
	for _, base := range releaseBases(id) {
		x.releases[base] = append(x.releases[base], f)
	}
}

// find looks id up: exact, then dot-versus-dash, then bare name to its one
// numbered release. The first step with candidates decides: one distinct
// set of facts is a match; several are ambiguous and give nothing.
func (x *index) find(id string) (Facts, bool) {
	if x == nil {
		return Facts{}, false
	}
	for _, c := range [][]Facts{x.exact[id], x.dashed[dashed(id)], x.releaseOf(id)} {
		if len(c) == 0 {
			continue
		}
		return unique(c)
	}
	return Facts{}, false
}

func (x *index) releaseOf(name string) []Facts {
	if !releaseName(name) {
		return nil
	}
	return x.releases[name]
}

func unique(c []Facts) (Facts, bool) {
	first := c[0].String()
	for _, f := range c[1:] {
		if f.String() != first {
			return Facts{}, false
		}
	}
	return c[0], true
}

// dashed reads dotted versions as dashed: claude-opus-4.7 -> claude-opus-4-7.
func dashed(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	b := []byte(s)
	for i := 1; i+1 < len(b); i++ {
		if b[i] == '.' && digit(b[i-1]) && digit(b[i+1]) {
			b[i] = '-'
		}
	}
	return string(b)
}

func digit(c byte) bool { return c >= '0' && c <= '9' }

// releaseName reports whether a bare name may stand for a numbered release:
// at least two dash parts, not ending in a number (claude-opus-4 is not a
// release family of claude-opus-4-1; image is not one of image-01).
func releaseName(s string) bool {
	parts := strings.Split(s, "-")
	return len(parts) >= 2 && !numeric(parts[len(parts)-1])
}

// releaseBases are the bare names id is a numbered release of:
// muse-wonder-1.0, muse-wonder-1-0 and gpt-4o-2024-05-13 are releases of
// muse-wonder and gpt-4o; muse-wonder-full is not a release.
func releaseBases(id string) []string {
	var out []string
	for i := 0; i < len(id); i++ {
		if id[i] != '-' {
			continue
		}
		base, rest := id[:i], id[i+1:]
		if releaseName(base) && numericRelease(rest) {
			out = append(out, base)
		}
	}
	return out
}

func numeric(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !digit(s[i]) {
			return false
		}
	}
	return true
}

// numericRelease: digits separated by dots or dashes (1.0, 1-0, 2507, 2024-05-13).
var numericRelease = regexp.MustCompile(`^\d+(?:[.-]\d+)*$`).MatchString

// variants are OpenRouter-style suffixes naming the same model with other
// routing (deepseek-r1:free); they are ignored when looking a model up.
var variants = []string{"free", "beta", "extended", "thinking", "online", "nitro", "floor", "exacto", "latest"}

// modelPart is the model a Caller-facing ID names, for the maker catalog:
// without a routing variant, and without any path (openai/gpt-4o -> gpt-4o).
func modelPart(id string) string {
	id = stripVariant(id)
	if i := strings.LastIndexByte(id, '/'); i >= 0 {
		id = id[i+1:]
	}
	return id
}

// Lookup finds model in models.dev. With a brand, the brand's own entry
// comes first (api.json); the maker catalog (models.json) fills the fields
// it lacks, matched by the full ID (openai/gpt-4o) or by the model part
// alone. Matching is exact, dot-versus-dash, or a bare name with a single
// numbered release; anything ambiguous gives nothing. Case is ignored.
func (c *Catalog) Lookup(brand, model string) Facts {
	if c == nil {
		return Facts{}
	}
	id := strings.ToLower(strings.TrimSpace(model))
	var layers []Facts
	if b := c.brands[strings.ToLower(brand)]; b != nil {
		if f, ok := b.find(id); ok {
			layers = append(layers, f)
		} else if f, ok := b.find(stripVariant(id)); ok {
			layers = append(layers, f)
		}
	}
	var maker Facts
	found := false
	if strings.Contains(id, "/") {
		maker, found = c.makers.find(stripVariant(id))
	}
	if !found {
		maker, found = c.plain.find(modelPart(id))
	}
	if found {
		layers = append(layers, maker)
	}
	return Resolve(layers...)
}

func stripVariant(id string) string {
	if i := strings.LastIndexByte(id, ':'); i >= 0 {
		for _, v := range variants {
			if id[i+1:] == v {
				return id[:i]
			}
		}
	}
	return id
}

// ErrEmpty is a models.dev file that names no model.
var ErrEmpty = errors.New("the catalog names no model")

// parseProviders reads api.json: {"<brand>": {"models": {"<key>": Model}}}.
func parseProviders(body []byte) (map[string]*index, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(body), &top); err != nil {
		return nil, err
	}
	out := map[string]*index{}
	n := 0
	for brand, raw := range top {
		var p struct {
			Models map[string]json.RawMessage `json:"models"`
		}
		if json.Unmarshal(raw, &p) != nil || p.Models == nil {
			continue
		}
		x := newIndex()
		for key, m := range p.Models {
			id, f, ok := entry(key, m)
			if !ok {
				continue
			}
			x.add(id, f)
			n++
		}
		out[strings.ToLower(brand)] = x
	}
	if n == 0 {
		return nil, ErrEmpty
	}
	return out, nil
}

// parseMakers reads models.json: {"<maker>/<model>": Model}.
func parseMakers(body []byte) (makers, plain *index, err error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(body), &top); err != nil {
		return nil, nil, err
	}
	makers, plain = newIndex(), newIndex()
	for key, m := range top {
		_, f, ok := entry(key, m)
		if !ok {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(key))
		makers.add(id, f)
		_, model, found := strings.Cut(id, "/")
		if !found {
			model = id
		}
		plain.add(model, f)
	}
	if len(makers.exact) == 0 {
		return nil, nil, ErrEmpty
	}
	return makers, plain, nil
}

// entry reads one models.dev model: its ID (lower case; the object's id,
// else its key) and facts. ok is false when nothing useful is known.
func entry(key string, raw json.RawMessage) (string, Facts, bool) {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return "", Facts{}, false
	}
	id := key
	if s, ok := m["id"].(string); ok && strings.TrimSpace(s) != "" {
		id = s
	}
	f := normalize(m)
	if f.IsZero() {
		return "", Facts{}, false
	}
	return strings.ToLower(strings.TrimSpace(id)), f, true
}

// NewCatalog builds a catalog from api.json and models.json bodies; either
// may be nil (that half is then empty). Tests use it directly.
func NewCatalog(providersJSON, makersJSON []byte) (*Catalog, error) {
	c := &Catalog{brands: map[string]*index{}, makers: newIndex(), plain: newIndex()}
	if providersJSON != nil {
		b, err := parseProviders(providersJSON)
		if err != nil {
			return nil, err
		}
		c.brands = b
	}
	if makersJSON != nil {
		m, p, err := parseMakers(makersJSON)
		if err != nil {
			return nil, err
		}
		c.makers, c.plain = m, p
	}
	return c, nil
}
