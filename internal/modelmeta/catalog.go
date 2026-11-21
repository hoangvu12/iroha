package modelmeta

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

type Catalog struct {
	byBrand      map[string]*index
	byMakerModel *index
	byModelPart  *index
}

func (c *Catalog) Size() int {
	if c == nil {
		return 0
	}
	n := len(c.byMakerModel.exact)
	for _, b := range c.byBrand {
		n += len(b.exact)
	}
	return n
}

type index struct {
	exact    map[string][]Facts
	dashed   map[string][]Facts
	releases map[bareName][]Facts
}

func newIndex() *index {
	return &index{exact: map[string][]Facts{}, dashed: map[string][]Facts{}, releases: map[bareName][]Facts{}}
}

func (x *index) add(id string, f Facts) {
	x.exact[id] = append(x.exact[id], f)
	x.dashed[dashed(id)] = append(x.dashed[dashed(id)], f)
	for _, base := range releasedAs(id) {
		x.releases[base] = append(x.releases[base], f)
	}
}

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
	base, ok := asBareName(name)
	if !ok {
		return nil
	}
	return x.releases[base]
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

type bareName string

func asBareName(s string) (bareName, bool) {
	parts := strings.Split(s, "-")
	if len(parts) < 2 || numeric(parts[len(parts)-1]) {
		return "", false
	}
	return bareName(s), true
}

func releasedAs(id string) []bareName {
	var out []bareName
	for i := 0; i < len(id); i++ {
		if id[i] != '-' {
			continue
		}
		if base, ok := asBareName(id[:i]); ok && isReleaseNumber(id[i+1:]) {
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

var isReleaseNumber = regexp.MustCompile(`^\d+(?:[.-]\d+)*$`).MatchString

// variants are OpenRouter-style suffixes naming the same model with other
// routing (deepseek-r1:free); they are ignored when looking a model up.
var variants = []string{"free", "beta", "extended", "thinking", "online", "nitro", "floor", "exacto", "latest"}

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
	if b := c.byBrand[strings.ToLower(brand)]; b != nil {
		if f, ok := b.find(id); ok {
			layers = append(layers, f)
		} else if f, ok := b.find(stripVariant(id)); ok {
			layers = append(layers, f)
		}
	}
	var maker Facts
	found := false
	if strings.Contains(id, "/") {
		maker, found = c.byMakerModel.find(stripVariant(id))
	}
	if !found {
		maker, found = c.byModelPart.find(modelPart(id))
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
func parseMakers(body []byte) (byMakerModel, byModelPart *index, err error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(body), &top); err != nil {
		return nil, nil, err
	}
	byMakerModel, byModelPart = newIndex(), newIndex()
	for key, m := range top {
		_, f, ok := entry(key, m)
		if !ok {
			continue
		}
		id := strings.ToLower(strings.TrimSpace(key))
		byMakerModel.add(id, f)
		_, model, found := strings.Cut(id, "/")
		if !found {
			model = id
		}
		byModelPart.add(model, f)
	}
	if len(byMakerModel.exact) == 0 {
		return nil, nil, ErrEmpty
	}
	return byMakerModel, byModelPart, nil
}

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
// may be nil (that half is then empty).
func NewCatalog(providersJSON, makersJSON []byte) (*Catalog, error) {
	c := emptyCatalog()
	if providersJSON != nil {
		b, err := parseProviders(providersJSON)
		if err != nil {
			return nil, err
		}
		c.byBrand = b
	}
	if makersJSON != nil {
		m, p, err := parseMakers(makersJSON)
		if err != nil {
			return nil, err
		}
		c.byMakerModel, c.byModelPart = m, p
	}
	return c, nil
}

func emptyCatalog() *Catalog {
	return &Catalog{byBrand: map[string]*index{}, byMakerModel: newIndex(), byModelPart: newIndex()}
}
