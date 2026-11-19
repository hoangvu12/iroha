package gateway

import (
	"bytes"
	"encoding/json"

	"github.com/hoangvu12/iroha/internal/shape"
)

// reportedModel reads the model an Endpoint's answer says served it (a
// dated snapshot, the model a router chose: MOD-06) from the answer in the
// Endpoint's Shape, before any echo or translation. It reads whole bodies
// and stream data payloads alike and keeps the first model it finds. The
// Caller still sees the model it asked for; the Attempt records this one.
type reportedModel struct {
	shape shape.Shape
	model string
}

// read looks for the model in one JSON body or stream event payload.
func (r *reportedModel) read(p []byte) {
	if r == nil || r.model != "" || len(p) == 0 || p[0] != '{' {
		return
	}
	r.model = specOf(r.shape).reported(p) // shapes.go
}

// Model is the model read so far ("" when the answer named none), at most
// 256 bytes.
func (r *reportedModel) Model() string {
	if len(r.model) > 256 {
		return r.model[:256]
	}
	return r.model
}

// stringField is the top-level string key of a JSON object, "" when absent
// or not a string.
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
