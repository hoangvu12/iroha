package requests

import (
	"encoding/json"
	"sort"
)

func reassembleResponses(payloads [][]byte) ([]byte, bool) {
	var resp map[string]any
	final := false
	items := map[int]map[string]any{}
	for _, p := range payloads {
		var ev struct {
			Type         string         `json:"type"`
			Response     map[string]any `json:"response"`
			OutputIndex  *int           `json:"output_index"`
			ContentIndex int            `json:"content_index"`
			SummaryIndex int            `json:"summary_index"`
			Item         map[string]any `json:"item"`
			Delta        string         `json:"delta"`
			Code         any            `json:"code"`
			Message      string         `json:"message"`
		}
		if json.Unmarshal(p, &ev) != nil {
			return nil, false
		}
		switch ev.Type {
		case "response.created", "response.in_progress", "response.queued":
			if !final && ev.Response != nil {
				resp = ev.Response
			}
		case "response.completed", "response.incomplete", "response.failed", "response.done":
			if ev.Response != nil {
				resp, final = ev.Response, true
			}
		case "response.output_item.added", "response.output_item.done":
			if ev.OutputIndex != nil && ev.Item != nil {
				items[*ev.OutputIndex] = ev.Item
			}
		case "response.output_text.delta", "response.refusal.delta":
			if item := items[at(ev.OutputIndex)]; item != nil {
				part := entry(item, "content", ev.ContentIndex, "output_text")
				key := "text"
				if ev.Type == "response.refusal.delta" {
					part["type"], key = "refusal", "refusal"
				}
				part[key] = str(part[key]) + ev.Delta
			}
		case "response.reasoning_summary_text.delta":
			if item := items[at(ev.OutputIndex)]; item != nil {
				part := entry(item, "summary", ev.SummaryIndex, "summary_text")
				part["text"] = str(part["text"]) + ev.Delta
			}
		case "response.function_call_arguments.delta":
			if item := items[at(ev.OutputIndex)]; item != nil {
				item["arguments"] = str(item["arguments"]) + ev.Delta
			}
		case "error":
			if resp == nil {
				resp = map[string]any{"object": "response"}
			}
			resp["status"] = "failed"
			resp["error"] = map[string]any{"code": ev.Code, "message": ev.Message}
		}
	}
	if resp == nil {
		return nil, false
	}
	if out, _ := resp["output"].([]any); (!final || len(out) == 0) && len(items) > 0 {
		idx := make([]int, 0, len(items))
		for i := range items {
			idx = append(idx, i)
		}
		sort.Ints(idx)
		output := make([]any, 0, len(idx))
		for _, i := range idx {
			output = append(output, items[i])
		}
		resp["output"] = output
	}
	b, err := json.Marshal(resp)
	return b, err == nil
}

func at(i *int) int {
	if i == nil {
		return 0
	}
	return *i
}

func entry(item map[string]any, key string, i int, typ string) map[string]any {
	l, _ := item[key].([]any)
	for len(l) <= i {
		l = append(l, map[string]any{"type": typ})
	}
	item[key] = l
	m, ok := l[i].(map[string]any)
	if !ok {
		m = map[string]any{"type": typ}
		l[i] = m
	}
	return m
}
