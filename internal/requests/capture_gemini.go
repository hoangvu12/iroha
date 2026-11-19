package requests

import "encoding/json"

// reassembleGemini merges Gemini stream chunks into one generateContent
// answer: each candidate's parts in order, consecutive text parts of the
// same kind (thought or not) joined, function calls kept whole, the last
// finish reason; top-level fields (usageMetadata, modelVersion,
// responseId) take their last value. An error chunk is kept as "error".
func reassembleGemini(payloads [][]byte) ([]byte, bool) {
	out := map[string]any{}
	type candidate struct {
		index float64
		role  any
		parts []map[string]any
		rest  map[string]any
	}
	var cands []*candidate
	byIndex := map[float64]*candidate{}
	for _, p := range payloads {
		var chunk map[string]any
		if json.Unmarshal(p, &chunk) != nil {
			return nil, false
		}
		for k, v := range chunk {
			if k != "candidates" && v != nil {
				out[k] = v
			}
		}
		list, _ := chunk["candidates"].([]any)
		for _, item := range list {
			cm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			idx, _ := cm["index"].(float64)
			c := byIndex[idx]
			if c == nil {
				c = &candidate{index: idx, rest: map[string]any{}}
				byIndex[idx] = c
				cands = append(cands, c)
			}
			for k, v := range cm {
				if k != "content" && k != "index" && v != nil {
					c.rest[k] = v
				}
			}
			content, _ := cm["content"].(map[string]any)
			if r := content["role"]; r != nil {
				c.role = r
			}
			parts, _ := content["parts"].([]any)
			for _, part := range parts {
				pm, ok := part.(map[string]any)
				if !ok {
					continue
				}
				if plainText(pm) {
					text := pm["text"].(string)
					if n := len(c.parts); n > 0 && plainText(c.parts[n-1]) && c.parts[n-1]["thought"] == pm["thought"] {
						c.parts[n-1]["text"] = c.parts[n-1]["text"].(string) + text
						continue
					}
					if text == "" {
						continue // an empty text (a keep-alive) adds nothing
					}
				}
				c.parts = append(c.parts, pm)
			}
		}
	}
	if len(cands) == 0 && len(out) == 0 {
		return nil, false
	}
	list := make([]any, 0, len(cands))
	for _, c := range cands {
		parts := make([]any, len(c.parts))
		for i, p := range c.parts {
			parts[i] = p
		}
		role := c.role
		if role == nil {
			role = "model"
		}
		cm := map[string]any{"index": c.index, "content": map[string]any{"role": role, "parts": parts}}
		for k, v := range c.rest {
			cm[k] = v
		}
		list = append(list, cm)
	}
	out["candidates"] = list
	b, err := json.Marshal(out)
	return b, err == nil
}

// plainText reports whether a part is only text (a thought or not).
func plainText(p map[string]any) bool {
	if _, ok := p["text"].(string); !ok {
		return false
	}
	for k := range p {
		if k != "text" && k != "thought" {
			return false
		}
	}
	return true
}
