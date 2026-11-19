// Package usage reads token usage out of upstream answers, per Shape,
// buffered bodies and stream events alike. Translation tickets (13-15) add
// the other Shapes here.
package usage

import "encoding/json"

// Usage is the token count of one answer.
type Usage struct {
	Input     int64 `json:"input" doc:"Prompt tokens, cached ones included."`
	Output    int64 `json:"output" doc:"Completion tokens, reasoning included."`
	CacheRead int64 `json:"cache_read" doc:"Prompt tokens served from the Provider's cache."`
	Reasoning int64 `json:"reasoning" doc:"Completion tokens spent on reasoning."`
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
