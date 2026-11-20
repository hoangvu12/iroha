package usage

import "encoding/json"

// responsesCounts is an OpenAI Responses usage object. input_tokens
// includes the cached and written ones, output_tokens the reasoning ones.
type responsesCounts struct {
	Input         *int64        `json:"input_tokens"`
	Output        *int64        `json:"output_tokens"`
	InputDetails  *inputDetails `json:"input_tokens_details"`
	CacheWrite    int64         `json:"cache_write_tokens"`
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
	var prompt int64
	if c.Input != nil {
		prompt = *c.Input
	}
	u = subset(prompt, c.InputDetails.cache(0, c.CacheWrite))
	if c.Output != nil {
		u.Output = *c.Output
	}
	if c.OutputDetails != nil {
		u.Reasoning = c.OutputDetails.ReasoningTokens
	}
	return u, true
}
