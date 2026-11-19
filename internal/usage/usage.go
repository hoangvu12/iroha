// Package usage reads token usage out of upstream answers, per Shape,
// buffered bodies and stream events alike. Usage is read from the answer in
// the Endpoint's Shape (what the Provider counted), before any translation.
// Translation tickets (14, 15) add the other Shapes to Reader.
package usage

import (
	"bytes"
	"encoding/json"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Usage is the token count of one answer.
type Usage struct {
	Input     int64 `json:"input" doc:"Prompt tokens, cached ones included."`
	Output    int64 `json:"output" doc:"Completion tokens, reasoning included."`
	CacheRead int64 `json:"cache_read" doc:"Prompt tokens served from the Provider's cache."`
	Reasoning int64 `json:"reasoning" doc:"Completion tokens spent on reasoning."`
}

// Reader collects the usage of one answer written in one Shape.
type Reader struct {
	sh  shape.Shape
	u   *Usage
	ant anthropicCounts // Anthropic streams spread usage over two events
}

// NewReader returns a Reader for answers in sh.
func NewReader(sh shape.Shape) *Reader { return &Reader{sh: sh} }

// Body reads a whole answer.
func (r *Reader) Body(b []byte) {
	switch r.sh {
	case shape.OpenAIChat:
		r.chat(b)
	case shape.AnthropicMessages:
		var v struct {
			Usage *anthropicCounts `json:"usage"`
		}
		if json.Unmarshal(b, &v) == nil && v.Usage != nil {
			r.ant.merge(*v.Usage)
			r.u = r.ant.usage()
		}
	}
}

// Event reads the data of one stream event.
func (r *Reader) Event(data []byte) {
	if len(data) == 0 || data[0] != '{' {
		return
	}
	if !bytes.Contains(data, []byte(`"usage"`)) {
		return // most events carry none; skip decoding them
	}
	switch r.sh {
	case shape.OpenAIChat:
		r.chat(data)
	case shape.AnthropicMessages:
		var v struct {
			Type    string `json:"type"`
			Message struct {
				Usage *anthropicCounts `json:"usage"`
			} `json:"message"`
			Usage *anthropicCounts `json:"usage"`
		}
		if json.Unmarshal(data, &v) != nil {
			return
		}
		switch {
		case v.Type == "message_start" && v.Message.Usage != nil:
			r.ant.merge(*v.Message.Usage)
		case v.Type == "message_delta" && v.Usage != nil:
			r.ant.merge(*v.Usage)
		default:
			return
		}
		r.u = r.ant.usage()
	}
}

// Usage is what was read, or nil when the answer carried none.
func (r *Reader) Usage() *Usage { return r.u }

func (r *Reader) chat(b []byte) {
	if u, ok := FromOpenAIChat(b); ok {
		r.u = &u
	}
}

type openAIChat struct {
	Usage *struct {
		PromptTokens        *int64 `json:"prompt_tokens"`
		CompletionTokens    *int64 `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		CompletionTokensDetails *struct {
			ReasoningTokens int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
}

// FromOpenAIChat reads the "usage" object of an OpenAI Chat Completions
// body or stream chunk. ok is false when there is none (absent or null).
func FromOpenAIChat(b []byte) (u Usage, ok bool) {
	var v openAIChat
	if json.Unmarshal(b, &v) != nil || v.Usage == nil || v.Usage.PromptTokens == nil && v.Usage.CompletionTokens == nil {
		return u, false
	}
	if p := v.Usage.PromptTokens; p != nil {
		u.Input = *p
	}
	if c := v.Usage.CompletionTokens; c != nil {
		u.Output = *c
	}
	if d := v.Usage.PromptTokensDetails; d != nil {
		u.CacheRead = d.CachedTokens
	}
	if d := v.Usage.CompletionTokensDetails; d != nil {
		u.Reasoning = d.ReasoningTokens
	}
	return u, true
}

// anthropicCounts is an Anthropic usage object. input_tokens excludes the
// cached prompt tokens, which Anthropic counts apart (read and written).
// In a stream message_start gives input and cache counts and message_delta
// the output; either may repeat a field, and a null keeps the earlier value.
type anthropicCounts struct {
	Input       *int64 `json:"input_tokens"`
	Output      *int64 `json:"output_tokens"`
	CacheRead   *int64 `json:"cache_read_input_tokens"`
	CacheCreate *int64 `json:"cache_creation_input_tokens"`
}

func (a *anthropicCounts) merge(b anthropicCounts) {
	for _, f := range []struct{ dst, src **int64 }{{&a.Input, &b.Input}, {&a.Output, &b.Output}, {&a.CacheRead, &b.CacheRead}, {&a.CacheCreate, &b.CacheCreate}} {
		if *f.src != nil {
			*f.dst = *f.src
		}
	}
}

func (a *anthropicCounts) usage() *Usage {
	v := func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	}
	return &Usage{Input: v(a.Input) + v(a.CacheRead) + v(a.CacheCreate), Output: v(a.Output), CacheRead: v(a.CacheRead)}
}
