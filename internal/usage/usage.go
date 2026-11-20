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

// Usage is the token count of one answer (OpenAI Chat, OpenAI Responses,
// Anthropic Messages, Gemini), in one convention whatever the Provider's:
// Input is every prompt token, and CacheRead and CacheWrite are parts of it.
// subset and separate are the only places a Provider's counts become it.
type Usage struct {
	Input          int64 `json:"input" doc:"Prompt tokens, all of them: uncached, read from the Provider's cache and written to it."`
	Output         int64 `json:"output" doc:"Completion tokens, reasoning included."`
	CacheRead      int64 `json:"cache_read" doc:"Part of input served from the Provider's prompt cache."`
	CacheWrite     int64 `json:"cache_write" doc:"Part of input written to the Provider's prompt cache (Anthropic, OpenAI GPT-5.6+, Kimi and Qwen report it; most bill it above normal input)."`
	CacheWriteLong int64 `json:"cache_write_long" doc:"Part of cache_write kept for the Provider's longer lifetime and billed higher (Anthropic's 1 h, OpenAI's 12 h); 0 when the Provider reports no split."`
	Reasoning      int64 `json:"reasoning" doc:"Completion tokens spent on reasoning."`
}

// cache is what an answer said about the Provider's prompt cache.
type cache struct{ read, write, writeLong int64 }

// subset is the usage of a Provider whose prompt count already includes the
// tokens read from and written to its cache (OpenAI Chat and Responses,
// Gemini, and the OpenAI-compatible APIs of DeepSeek, Qwen, Kimi...).
func subset(prompt int64, c cache) Usage {
	return Usage{Input: prompt, CacheRead: c.read, CacheWrite: c.write, CacheWriteLong: c.writeLong}
}

// separate is the usage of a Provider that counts uncached prompt tokens,
// cache reads and cache writes apart (Anthropic Messages: input_tokens is
// only what follows the last cache breakpoint).
func separate(uncached int64, c cache) Usage {
	return Usage{Input: uncached + c.read + c.write, CacheRead: c.read, CacheWrite: c.write, CacheWriteLong: c.writeLong}
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
	case shape.OpenAIResponses:
		r.responses(b)
	case shape.AnthropicMessages:
		var v struct {
			Usage *anthropicCounts `json:"usage"`
		}
		if json.Unmarshal(b, &v) == nil && v.Usage != nil {
			r.ant.merge(*v.Usage)
			r.u = r.ant.usage()
		}
	case shape.Gemini:
		r.gemini(b)
	}
}

// Event reads the data of one stream event.
func (r *Reader) Event(data []byte) {
	if len(data) == 0 || data[0] != '{' {
		return
	}
	if !bytes.Contains(data, []byte(`"usage`)) { // "usage" or Gemini's "usageMetadata"
		return // most events carry none; skip decoding them
	}
	switch r.sh {
	case shape.OpenAIChat:
		r.chat(data)
	case shape.OpenAIResponses:
		r.responses(data)
	case shape.Gemini:
		r.gemini(data) // each chunk's counts are the stream's so far
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

// gemini reads a Gemini usageMetadata. Gemini counts thoughts and tool-use
// prompts apart: thoughts are output (and reasoning), tool-use prompt tokens
// input; cached content is part of the prompt count. It reports no writes.
func (r *Reader) gemini(b []byte) {
	var v struct {
		Usage *struct {
			Prompt     int64 `json:"promptTokenCount"`
			ToolPrompt int64 `json:"toolUsePromptTokenCount"`
			Candidates int64 `json:"candidatesTokenCount"`
			Thoughts   int64 `json:"thoughtsTokenCount"`
			Cached     int64 `json:"cachedContentTokenCount"`
		} `json:"usageMetadata"`
	}
	if json.Unmarshal(b, &v) != nil || v.Usage == nil {
		return
	}
	u := v.Usage
	out := subset(u.Prompt+u.ToolPrompt, cache{read: u.Cached})
	out.Output, out.Reasoning = u.Candidates+u.Thoughts, u.Thoughts
	r.u = &out
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
		PromptTokens        *int64        `json:"prompt_tokens"`
		CompletionTokens    *int64        `json:"completion_tokens"`
		PromptTokensDetails *inputDetails `json:"prompt_tokens_details"`
		// DeepSeek reports its cache hits here, Moonshot's older answers
		// cached_tokens, OpenRouter-style relays cache_write_tokens.
		PromptCacheHitTokens    int64 `json:"prompt_cache_hit_tokens"`
		CachedTokens            int64 `json:"cached_tokens"`
		CacheWriteTokens        int64 `json:"cache_write_tokens"`
		CompletionTokensDetails *struct {
			ReasoningTokens int64 `json:"reasoning_tokens"`
		} `json:"completion_tokens_details"`
	} `json:"usage"`
}

// inputDetails is OpenAI's prompt_tokens_details (Chat) or
// input_tokens_details (Responses), with the names other Providers put in
// it: Qwen's cache_creation_input_tokens and cache_creation.
type inputDetails struct {
	CachedTokens             int64 `json:"cached_tokens"`
	CacheWriteTokens         int64 `json:"cache_write_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheWriteTokensDetails  *struct {
		TTL12h int64 `json:"ttl_12h_tokens"`
	} `json:"cache_write_tokens_details"`
	CacheCreation *ttlSplit `json:"cache_creation"`
}

// ttlSplit is Anthropic's (and Qwen's) split of cache writes by lifetime.
type ttlSplit struct {
	Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
}

// cache reads the details, with read and write counts found beside them
// (top-level fields some Providers use). Several names for one count are
// the same tokens told twice, never added: the largest wins.
func (d *inputDetails) cache(read, write int64) cache {
	c := cache{read: read, write: write}
	if d == nil {
		return c
	}
	c.read = max(c.read, d.CachedTokens)
	c.write = max(c.write, d.CacheWriteTokens, d.CacheCreationInputTokens)
	if d.CacheWriteTokensDetails != nil {
		c.writeLong = d.CacheWriteTokensDetails.TTL12h
	}
	if d.CacheCreation != nil {
		c.writeLong = max(c.writeLong, d.CacheCreation.Ephemeral1h)
	}
	return c
}

// FromOpenAIChat reads the "usage" object of an OpenAI Chat Completions
// body or stream chunk. ok is false when there is none (absent or null).
func FromOpenAIChat(b []byte) (u Usage, ok bool) {
	var v openAIChat
	if json.Unmarshal(b, &v) != nil || v.Usage == nil || v.Usage.PromptTokens == nil && v.Usage.CompletionTokens == nil {
		return u, false
	}
	c := v.Usage
	var prompt int64
	if c.PromptTokens != nil {
		prompt = *c.PromptTokens
	}
	u = subset(prompt, c.PromptTokensDetails.cache(max(c.PromptCacheHitTokens, c.CachedTokens), c.CacheWriteTokens))
	if c.CompletionTokens != nil {
		u.Output = *c.CompletionTokens
	}
	if d := c.CompletionTokensDetails; d != nil {
		u.Reasoning = d.ReasoningTokens
	}
	return u, true
}

// anthropicCounts is an Anthropic usage object. input_tokens excludes the
// cached prompt tokens, which Anthropic counts apart (read and written).
// In a stream message_start gives input and cache counts and message_delta
// the output; either may repeat a field, and a null keeps the earlier value.
type anthropicCounts struct {
	Input       *int64    `json:"input_tokens"`
	Output      *int64    `json:"output_tokens"`
	CacheRead   *int64    `json:"cache_read_input_tokens"`
	CacheCreate *int64    `json:"cache_creation_input_tokens"`
	Split       *ttlSplit `json:"cache_creation"`
}

func (a *anthropicCounts) merge(b anthropicCounts) {
	for _, f := range []struct{ dst, src **int64 }{{&a.Input, &b.Input}, {&a.Output, &b.Output}, {&a.CacheRead, &b.CacheRead}, {&a.CacheCreate, &b.CacheCreate}} {
		if *f.src != nil {
			*f.dst = *f.src
		}
	}
	if b.Split != nil {
		a.Split = b.Split
	}
}

func (a *anthropicCounts) usage() *Usage {
	v := func(p *int64) int64 {
		if p == nil {
			return 0
		}
		return *p
	}
	c := cache{read: v(a.CacheRead), write: v(a.CacheCreate)}
	if a.Split != nil {
		c.writeLong = a.Split.Ephemeral1h
	}
	u := separate(v(a.Input), c)
	u.Output = v(a.Output)
	return &u
}
