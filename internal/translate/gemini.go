package translate

import (
	"encoding/json"
	"mime"
	"net/url"
	"path"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

var geminiShape = shapeFormat{shape.Gemini, types.RelayFormatGemini}

var geminiEndpoint = &endpointCodec{
	shapeFormat: geminiShape,
	answer:      func() any { return &dto.GeminiChatResponse{} },
	event:       func() any { return &dto.GeminiChatResponse{} },
	writeFormat: writeGeminiFormat,

	declaredTools: func(req map[string]any) []string {
		var names []string
		for _, d := range functionDeclarations(req) {
			names = append(names, str(d["name"]))
		}
		return names
	},

	prepareRequest: func(req map[string]any, t *Translation) {
		if tools, ok := req["tools"].([]any); ok && len(tools) == 0 {
			delete(req, "tools")
		}
		for _, d := range functionDeclarations(req) {
			rename(d, "name", t.names.safe)
			if v, ok := d["parameters"]; ok && v == nil {
				delete(d, "parameters")
			}
		}
		if fc := obj(obj(req["toolConfig"])["functionCallingConfig"]); fc != nil {
			names := list(fc["allowedFunctionNames"])
			for i, n := range names {
				if s, ok := n.(string); ok {
					names[i] = t.names.safe(s)
				}
			}
		}
		for _, c := range list(req["contents"]) {
			for _, p := range list(obj(c)["parts"]) {
				p := obj(p)
				rename(obj(p["functionCall"]), "name", t.names.safe)
				rename(obj(p["functionResponse"]), "name", t.names.safe)
				fileURIs(p)
			}
		}
	},

	upstream: func(data []byte) upstreamEvent {
		var v struct {
			Error *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
				Status  string `json:"status"`
			} `json:"error"`
			Candidates []struct {
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
			PromptFeedback *struct {
				BlockReason string `json:"blockReason"`
			} `json:"promptFeedback"`
		}
		if json.Unmarshal(data, &v) != nil {
			return upstreamEvent{feed: true}
		}
		if v.Error != nil {
			return upstreamEvent{err: &UpstreamError{Type: v.Error.Status, Message: v.Error.Message}}
		}
		ev := upstreamEvent{feed: true}
		for _, c := range v.Candidates {
			if c.FinishReason != "" {
				ev.complete = true
			}
		}
		if v.PromptFeedback != nil && v.PromptFeedback.BlockReason != "" {
			ev.complete = true // the prompt was refused: no candidate follows
		}
		return ev
	},
}

var geminiCaller = &callerCodec{
	shapeFormat: geminiShape,
	request:     func() any { return &dto.GeminiChatRequest{} },
	setModel:    func(any, string) {}, // the model is in the URL path
	readFormat:  readGeminiFormat,
	noteRequest: func(req any, t *Translation) {
		if tc := req.(*dto.GeminiChatRequest).GenerationConfig.ThinkingConfig; tc != nil && tc.IncludeThoughts != nil {
			t.thoughts = *tc.IncludeThoughts
		}
	},

	tidyAnswer: func(m map[string]any, t *Translation, _ *dto.Usage) {
		tidyGemini(m, t)
		// RelayKit's converter from Chat drops reasoning and the cached and
		// reasoning token counts.
		for _, c := range list(t.chat["choices"]) {
			c := obj(c)
			r := str(obj(c["message"])["reasoning_content"])
			if r == "" || !t.thoughts {
				continue
			}
			for _, cand := range list(m["candidates"]) {
				cand := obj(cand)
				if num(cand["index"]) == num(c["index"]) {
					content := obj(cand["content"])
					content["parts"] = append([]any{map[string]any{"text": r, "thought": true}}, list(content["parts"])...)
				}
			}
		}
		if u := geminiUsageFromChat(obj(t.chat["usage"])); u != nil {
			m["usageMetadata"] = u
		}
	},

	newWriter:      func(t *Translation, _ StreamOptions) streamWriter { return &geminiWriter{t: t} },
	answersViaChat: true,
}

func functionDeclarations(req map[string]any) []map[string]any {
	var decls []map[string]any
	for _, tool := range list(req["tools"]) {
		for _, d := range list(obj(tool)["functionDeclarations"]) {
			decls = append(decls, obj(d))
		}
	}
	return decls
}

func fileURIs(part map[string]any) {
	in := obj(part["inlineData"])
	if in == nil {
		return
	}
	u, ok := urlFromMarker(str(in["data"]))
	if !ok {
		return
	}
	mt := str(in["mimeType"])
	if mt == "" {
		mt = guessMIME(u)
	}
	delete(part, "inlineData")
	part["fileData"] = map[string]any{"mimeType": mt, "fileUri": u}
}

func guessMIME(raw string) string {
	p := raw
	if u, err := url.Parse(raw); err == nil {
		p = u.Path
	}
	if t := mime.TypeByExtension(strings.ToLower(path.Ext(p))); t != "" {
		t, _, _ = strings.Cut(t, ";")
		return t
	}
	return "image/jpeg"
}

func tidyGemini(m map[string]any, t *Translation) {
	m["modelVersion"] = t.o.Model
	if str(m["responseId"]) == "" {
		m["responseId"] = t.o.ID
	}
	if m["promptFeedback"] == nil {
		delete(m, "promptFeedback")
	}
	if u := geminiUsage(obj(m["usageMetadata"])); len(u) > 0 {
		m["usageMetadata"] = u
	} else {
		delete(m, "usageMetadata")
	}
	for _, c := range list(m["candidates"]) {
		c := obj(c)
		for _, k := range []string{"safetyRatings", "finishReason", "groundingMetadata", "continuationToken"} {
			if v, ok := c[k].([]any); c[k] == nil || ok && len(v) == 0 {
				delete(c, k)
			}
		}
		for _, p := range list(obj(c["content"])["parts"]) {
			rename(obj(obj(p)["functionCall"]), "name", t.names.original)
		}
	}
}

func geminiUsage(u map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount"} {
		if n, ok := u[k].(json.Number); ok && n.String() != "0" {
			out[k] = n
		}
	}
	if len(out) == 0 {
		return nil
	}
	for _, k := range []string{"promptTokenCount", "candidatesTokenCount", "totalTokenCount"} {
		if _, ok := out[k]; !ok {
			out[k] = 0
		}
	}
	return out
}

// Gemini counts thoughts apart from the candidates; Chat counts reasoning
// inside completion_tokens.
func geminiUsageFromChat(u map[string]any) map[string]any {
	if u == nil || u["prompt_tokens"] == nil && u["completion_tokens"] == nil {
		return nil
	}
	prompt, completion := num(u["prompt_tokens"]), num(u["completion_tokens"])
	thoughts := num(obj(u["completion_tokens_details"])["reasoning_tokens"])
	total := num(u["total_tokens"])
	if total == 0 {
		total = prompt + completion
	}
	out := map[string]any{"promptTokenCount": prompt, "candidatesTokenCount": max(completion-thoughts, 0), "totalTokenCount": total}
	if thoughts > 0 {
		out["thoughtsTokenCount"] = thoughts
	}
	if cached := num(obj(u["prompt_tokens_details"])["cached_tokens"]); cached > 0 {
		out["cachedContentTokenCount"] = cached
	}
	return out
}

func num(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			f, _ := n.Float64()
			return int64(f)
		}
		return i
	case float64:
		return int64(n)
	}
	return 0
}

// Chat sends usage in its own chunk after the finish, but Gemini SDKs
// expect it on the last chunk with the candidate (chunk.text of a
// candidate-less chunk prints "None"), so the finish chunk is held.
type geminiWriter struct {
	t       *Translation
	usage   map[string]any
	pending map[string]any
}

func (w *geminiWriter) chat(m map[string]any) []byte {
	if u := obj(m["usage"]); u != nil {
		w.usage = u
	}
	var out []byte
	for _, c := range list(m["choices"]) {
		c := obj(c)
		r := str(obj(c["delta"])["reasoning_content"])
		if r == "" || !w.t.thoughts {
			continue
		}
		out = append(out, w.write(map[string]any{"candidates": []any{map[string]any{
			"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": r, "thought": true}}},
			"index":   c["index"],
		}}})...)
	}
	return out
}

func (w *geminiWriter) write(m map[string]any) []byte {
	tidyGemini(m, w.t)
	if m["usageMetadata"] != nil {
		if u := geminiUsageFromChat(w.usage); u != nil {
			m["usageMetadata"] = u
		}
	}
	if !geminiSaysSomething(m) {
		return nil
	}
	var out []byte
	if p := w.pending; p != nil {
		w.pending = nil
		if len(list(m["candidates"])) == 0 {
			if m["usageMetadata"] != nil {
				p["usageMetadata"] = m["usageMetadata"]
			}
			return w.frame(p)
		}
		out = w.frame(p)
	}
	for _, c := range list(m["candidates"]) {
		if str(obj(c)["finishReason"]) != "" {
			w.pending = m
			return out
		}
	}
	return append(out, w.frame(m)...)
}

func (w *geminiWriter) frame(m map[string]any) []byte {
	for _, c := range list(m["candidates"]) {
		// A chunk with no part reads as no text at all to the SDKs
		// (chunk.text is None); Gemini ends with an empty text instead.
		if content := obj(obj(c)["content"]); content != nil && len(list(content["parts"])) == 0 {
			content["parts"] = []any{map[string]any{"text": ""}}
		}
	}
	b, _ := marshal(m)
	return append(append([]byte("data: "), b...), "\n\n"...)
}

func geminiSaysSomething(m map[string]any) bool {
	if m["usageMetadata"] != nil || m["promptFeedback"] != nil {
		return true
	}
	for _, c := range list(m["candidates"]) {
		c := obj(c)
		if str(c["finishReason"]) != "" || len(list(obj(c["content"])["parts"])) > 0 {
			return true
		}
	}
	return false
}

func (w *geminiWriter) end(*dto.Usage) []byte {
	if p := w.pending; p != nil {
		w.pending = nil
		return w.frame(p)
	}
	return nil
}
