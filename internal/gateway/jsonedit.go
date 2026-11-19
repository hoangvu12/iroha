package gateway

import (
	"bytes"
	"encoding/json"
)

// Passthrough edits a JSON object in place: only the bytes of the one
// top-level value changed are replaced, so everything else the Caller or
// Provider wrote (unknown fields, key order, spacing) reaches the other side
// byte for byte.

// span locates the value of a top-level key of a JSON object. ok is false
// when obj is not a JSON object. When key is absent, found is false and
// closing is the index of the object's closing brace; fields counts the
// object's members.
type span struct {
	start, end int
	found      bool
	closing    int
	fields     int
}

func locate(obj []byte, key string) (s span, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(obj))
	t, err := dec.Token()
	if err != nil || t != json.Delim('{') {
		return s, false
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return s, false
		}
		k, _ := kt.(string)
		before := int(dec.InputOffset())
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return s, false
		}
		after := int(dec.InputOffset())
		s.fields++
		if k == key { // the last occurrence wins, as in most parsers
			i := bytes.Index(obj[before:after], raw)
			if i < 0 {
				return s, false
			}
			s.start, s.end, s.found = before+i, before+i+len(raw), true
		}
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return s, false
	}
	s.closing = int(dec.InputOffset()) - 1
	return s, true
}

// field returns the raw value of a top-level key.
func field(obj []byte, key string) (json.RawMessage, bool) {
	s, ok := locate(obj, key)
	if !ok || !s.found {
		return nil, false
	}
	return json.RawMessage(obj[s.start:s.end]), true
}

// setField returns obj with the top-level key set to value (raw JSON):
// replaced where it stands, or appended when absent. ok is false when obj is
// not a JSON object; obj is then returned unchanged.
func setField(obj []byte, key string, value []byte) ([]byte, bool) {
	s, ok := locate(obj, key)
	if !ok {
		return obj, false
	}
	var b bytes.Buffer
	b.Grow(len(obj) + len(key) + len(value) + 4)
	if s.found {
		b.Write(obj[:s.start])
		b.Write(value)
		b.Write(obj[s.end:])
		return b.Bytes(), true
	}
	b.Write(obj[:s.closing])
	if s.fields > 0 {
		b.WriteByte(',')
	}
	k, _ := json.Marshal(key)
	b.Write(k)
	b.WriteByte(':')
	b.Write(value)
	b.Write(obj[s.closing:])
	return b.Bytes(), true
}

// jsonString encodes s as a JSON string without HTML escaping.
func jsonString(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return bytes.TrimRight(b.Bytes(), "\n")
}

// echoModel makes the top-level "model" of a JSON object read model, the
// name the Caller asked for. Anything that is not an object with a string
// model is returned unchanged.
func echoModel(obj []byte, model string) []byte {
	if !bytes.Contains(obj, []byte(`"model"`)) {
		return obj
	}
	raw, ok := field(obj, "model")
	if !ok || len(raw) == 0 || raw[0] != '"' {
		return obj
	}
	var cur string
	if json.Unmarshal(raw, &cur) != nil || cur == model {
		return obj
	}
	out, _ := setField(obj, "model", jsonString(model))
	return out
}
