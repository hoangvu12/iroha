package gateway

import (
	"bytes"
	"encoding/json"

	"github.com/hoangvu12/iroha/internal/shape"
)

type reportedModel struct {
	shape shape.Shape
	model string
}

func (r *reportedModel) read(p []byte) {
	if r == nil || r.model != "" || len(p) == 0 || p[0] != '{' {
		return
	}
	r.model = specOrChat(r.shape).reported(p)
}

const maxReportedModelBytes = 256

func (r *reportedModel) Model() string {
	if len(r.model) > maxReportedModelBytes {
		return r.model[:maxReportedModelBytes]
	}
	return r.model
}

func stringField(obj []byte, key string) string {
	if !bytes.Contains(obj, []byte(`"`+key+`"`)) {
		return ""
	}
	raw, ok := field(obj, key)
	if !ok || len(raw) == 0 || raw[0] != '"' {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}
