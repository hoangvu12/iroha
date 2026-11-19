package normalise

import (
	"bytes"
	"encoding/json"
	"strings"
)

// OpenAI Chat answers.

// chatBody normalises a whole chat.completion. Bodies that are not JSON
// objects, carry no choices, or are error envelopes pass unchanged.
func (s Set) chatBody(body []byte) ([]byte, error) {
	m, ok := decodeObject(body)
	if !ok || isError(m) {
		return body, nil
	}
	changed := false
	for _, c := range list(m["choices"]) {
		c := obj(c)
		if c == nil {
			continue
		}
		if msg := obj(c["message"]); msg != nil && s.message(msg) {
			changed = true
		}
		ch, err := s.finishReason(c)
		if err != nil {
			return nil, err
		}
		changed = changed || ch
	}
	if !changed {
		return body, nil
	}
	return encode(m, body), nil
}

// message normalises the message of one choice of a whole answer.
func (s Set) message(msg map[string]any) bool {
	changed := s.vendorFields(msg, false)
	if s.has(ChatContentBlocks) && flattenBlocks(msg) {
		changed = true
	}
	if !s.has(ChatReasoningTags) {
		return changed
	}
	content, ok := msg["content"].(string)
	if !ok || content == "" {
		return changed
	}
	if native := nativeReasoning(msg); native != "" {
		if content == native {
			msg["content"] = ""
			return true
		}
		return changed
	}
	var sp splitter
	r, c, acted := sp.feed(content)
	fr, fc := sp.flush()
	if !acted && fr == "" && fc == "" {
		return changed
	}
	msg["reasoning_content"], msg["content"] = r+fr, c+fc
	return true
}

// vendorFields drops audio_content and a brand name. A whole message keeps a
// name equal to its role; a delta loses any non-empty name.
func (s Set) vendorFields(msg map[string]any, delta bool) bool {
	if !s.has(ChatVendorFields) {
		return false
	}
	changed := false
	if _, ok := msg["audio_content"]; ok {
		delete(msg, "audio_content")
		changed = true
	}
	if name := str(msg["name"]); name != "" && (delta || name != str(msg["role"])) {
		delete(msg, "name")
		changed = true
	}
	return changed
}

// finishReason applies Z.ai's finish reasons to one choice.
func (s Set) finishReason(c map[string]any) (bool, error) {
	if !s.has(ZaiFinishReasons) {
		return false, nil
	}
	switch str(c["finish_reason"]) {
	case "sensitive":
		c["finish_reason"] = "content_filter"
	case "model_context_window_exceeded":
		c["finish_reason"] = "length"
	case "network_error":
		return false, &Failure{Message: "the Provider ended the answer with finish_reason network_error (it failed midway)"}
	default:
		return false, nil
	}
	return true, nil
}

// flattenBlocks turns a content array of text and thinking blocks into text
// content, the thinking into reasoning_content (unless the message has its
// own). GLM writes thinking as {"type":"thinking","thinking":[{"text":...}]};
// a plain string under "thinking" is read too. Other blocks are dropped.
func flattenBlocks(msg map[string]any) bool {
	blocks, ok := msg["content"].([]any)
	if !ok {
		return false
	}
	var text, reasoning strings.Builder
	for _, b := range blocks {
		b := obj(b)
		switch str(b["type"]) {
		case "text":
			text.WriteString(str(b["text"]))
		case "thinking", "reasoning":
			switch t := b["thinking"].(type) {
			case string:
				reasoning.WriteString(t)
			case []any:
				for _, part := range t {
					reasoning.WriteString(str(obj(part)["text"]))
				}
			}
			reasoning.WriteString(str(b["text"]))
		}
	}
	msg["content"] = text.String()
	if reasoning.Len() > 0 && nativeReasoning(msg) == "" {
		msg["reasoning_content"] = reasoning.String()
	}
	return true
}

// nativeReasoning is the reasoning a message or delta carries in a field of
// its own: reasoning_content (DeepSeek, Kimi, GLM) or reasoning (OpenRouter).
func nativeReasoning(m map[string]any) string {
	if r := str(m["reasoning_content"]); r != "" {
		return r
	}
	return str(m["reasoning"])
}

func isError(m map[string]any) bool {
	e, ok := m["error"]
	return ok && e != nil
}

// Stream normalises one streamed OpenAI Chat answer, chunk by chunk. Use
// one per Attempt.
type Stream struct {
	set     Set
	choices map[int]*choiceState
	order   []int // choice indexes in the order they appeared
	env     map[string]any
	closed  bool // the end of the answer was handled (held text, finish)
	done    bool // [DONE] passed
	// closedUnfinished: Iroha added the finish the Provider left out.
	closedUnfinished bool
}

type choiceState struct {
	split    splitter
	native   bool // the choice carries reasoning_content of its own
	tools    bool // it made tool calls
	finished bool // a finish_reason arrived
}

var done = []byte("[DONE]")

// Event takes the data of one server-sent event and returns the data to
// send in its place: usually data itself, untouched; possibly more events
// before it (held text, a closing chunk) or none. A *Failure means the
// Provider reported a failure: the stream is over.
func (st *Stream) Event(data []byte) ([][]byte, error) {
	if bytes.Equal(bytes.TrimSpace(data), done) {
		if st.done {
			return nil, nil // [DONE] once
		}
		st.done = true
		return append(st.close(), data), nil
	}
	m, ok := decodeObject(data)
	if !ok || isError(m) {
		return [][]byte{data}, nil
	}
	st.envelope(m)
	choices, ok := m["choices"].([]any)
	if !ok {
		return [][]byte{data}, nil
	}
	if len(choices) == 0 {
		if _, usage := m["usage"]; usage {
			return append(st.close(), data), nil // the usage chunk comes after the finish
		}
		return [][]byte{data}, nil
	}
	changed := false
	for _, c := range choices {
		c := obj(c)
		if c == nil {
			continue
		}
		ch, err := st.choice(c)
		if err != nil {
			return nil, err
		}
		changed = changed || ch
	}
	if !changed {
		return [][]byte{data}, nil
	}
	return [][]byte{encode(m, data)}, nil
}

// End is called when the Provider ended its body without a transport error.
// It returns the data of events to send before the stream ends: text held
// back, and, for an answer that never said it finished, a closing chunk and
// [DONE].
func (st *Stream) End() [][]byte {
	if st.done {
		return nil
	}
	out := st.close()
	if st.closedUnfinished {
		st.done = true
		out = append(out, done)
	}
	return out
}

// choice normalises the delta of one choice in a chunk.
func (st *Stream) choice(c map[string]any) (bool, error) {
	s := st.set
	idx := index(c)
	cs := st.choices[idx]
	if cs == nil {
		cs = &choiceState{}
		st.choices[idx] = cs
		st.order = append(st.order, idx)
	}
	changed := false
	delta := obj(c["delta"])
	if delta != nil {
		changed = s.vendorFields(delta, true)
		if s.has(ChatContentBlocks) && flattenBlocks(delta) {
			changed = true
		}
		if len(list(delta["tool_calls"])) > 0 {
			cs.tools = true
		}
		if s.has(ChatReasoningTags) && st.reasoning(delta, cs) {
			changed = true
		}
	}
	if fr := str(c["finish_reason"]); fr != "" {
		ch, err := s.finishReason(c)
		if err != nil {
			return false, err
		}
		changed = changed || ch
		cs.finished = true
		if cs.split.pending() { // the answer ends here: nothing more is held
			if delta == nil {
				delta = map[string]any{}
				c["delta"] = delta
			}
			r, t := cs.split.flush()
			addText(delta, r, t)
			changed = true
		}
	}
	return changed, nil
}

// reasoning applies the reasoning normaliser to one delta.
func (st *Stream) reasoning(d map[string]any, cs *choiceState) bool {
	if str(d["reasoning_content"]) != "" {
		cs.native = true
	}
	content, ok := d["content"].(string)
	if !ok || content == "" {
		return false
	}
	if cs.native {
		if content == str(d["reasoning_content"]) {
			d["content"] = ""
			return true
		}
		return false
	}
	if r := str(d["reasoning"]); r != "" {
		// OpenRouter's reasoning field, with the same text (and the tags)
		// echoed into content: keep only what follows the reasoning.
		rest := content
		switch {
		case strings.HasPrefix(content, r):
			rest = content[len(r):]
		case strings.HasPrefix(r, content):
			rest = ""
		}
		_, text, _ := cs.split.feed(rest)
		if text == content {
			return false
		}
		d["content"] = text
		return true
	}
	r, text, acted := cs.split.feed(content)
	if !acted {
		return false
	}
	// Both fields, empty strings included, so consecutive deltas look alike.
	d["content"], d["reasoning_content"] = text, r
	return true
}

// close handles the end of the answer once: text still held back goes out,
// and choices that never finished get a closing chunk.
func (st *Stream) close() [][]byte {
	if st.closed {
		return nil
	}
	st.closed = true
	var out [][]byte
	for _, idx := range st.order {
		cs := st.choices[idx]
		if !cs.split.pending() {
			continue
		}
		r, t := cs.split.flush()
		d := map[string]any{}
		addText(d, r, t)
		out = append(out, st.chunk([]any{map[string]any{"index": idx, "delta": d}}))
	}
	if !st.set.has(ChatFinishReason) {
		return out
	}
	var finish []any
	for _, idx := range st.order {
		if cs := st.choices[idx]; !cs.finished {
			reason := "stop"
			if cs.tools {
				reason = "tool_calls"
			}
			finish = append(finish, map[string]any{"index": idx, "delta": map[string]any{}, "finish_reason": reason})
		}
	}
	if len(finish) > 0 {
		st.closedUnfinished = true
		out = append(out, st.chunk(finish))
	}
	return out
}

// addText sets the text held back on a delta (both fields, like the deltas
// before it).
func addText(d map[string]any, reasoning, text string) {
	d["content"] = str(d["content"]) + text
	d["reasoning_content"] = str(d["reasoning_content"]) + reasoning
}

// envelope remembers the identifying fields of the last chunk, for chunks
// Iroha adds.
func (st *Stream) envelope(m map[string]any) {
	env := map[string]any{}
	for _, k := range []string{"id", "object", "created", "model", "system_fingerprint"} {
		if v, ok := m[k]; ok && v != nil {
			env[k] = v
		}
	}
	if len(env) > 0 {
		st.env = env
	}
}

// chunk is the data of a chunk Iroha adds, named like the Provider's.
func (st *Stream) chunk(choices []any) []byte {
	m := map[string]any{"object": "chat.completion.chunk"}
	for k, v := range st.env {
		m[k] = v
	}
	m["choices"] = choices
	return encode(m, nil)
}

func index(c map[string]any) int {
	if n, ok := c["index"].(json.Number); ok {
		if i, err := n.Int64(); err == nil {
			return int(i)
		}
	}
	return 0
}
