package usage

import "encoding/json"

// responsesCounts is an OpenAI Responses usage object. input_tokens
// includes the cached ones, output_tokens the reasoning ones.
type responsesCounts struct {
	Input        *int64 `json:"input_tokens"`
	Output       *int64 `json:"output_tokens"`
	InputDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
	OutputDetails *struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
}

func (r *Reader) responses(b []byte) {
	if u, ok := fromResponses(b); ok {
		r.u = &u
	}
}

// fromResponses reads the usage of a Responses answer: a whole response
// object, or a stream event whose response object carries it (the final
// response.completed, response.incomplete or response.failed).
func fromResponses(b []byte) (u Usage, ok bool) {
	var v struct {
		Usage    *responsesCounts `json:"usage"`
		Response *struct {
			Usage *responsesCounts `json:"usage"`
		} `json:"response"`
	}
	if json.Unmarshal(b, &v) != nil {
		return u, false
	}
	c := v.Usage
	if c == nil && v.Response != nil {
		c = v.Response.Usage
	}
	if c == nil || c.Input == nil && c.Output == nil {
		return u, false
	}
	if c.Input != nil {
		u.Input = *c.Input
	}
	if c.Output != nil {
		u.Output = *c.Output
	}
	if c.InputDetails != nil {
		u.CacheRead = c.InputDetails.CachedTokens
	}
	if c.OutputDetails != nil {
		u.Reasoning = c.OutputDetails.ReasoningTokens
	}
	return u, true
}
