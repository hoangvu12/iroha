// Package shape names the API formats (Shapes) a request or response can be
// written in.
package shape

// Shape is one API format.
type Shape string

const (
	OpenAIChat        Shape = "openai-chat"        // POST /v1/chat/completions
	OpenAIResponses   Shape = "openai-responses"   // POST /v1/responses
	AnthropicMessages Shape = "anthropic-messages" // POST /v1/messages
	Gemini            Shape = "gemini"             // POST /v1beta/models/{model}:generateContent
)

// All lists every Shape.
var All = []Shape{OpenAIChat, OpenAIResponses, AnthropicMessages, Gemini}

// Valid reports whether s is a known Shape.
func (s Shape) Valid() bool {
	for _, x := range All {
		if s == x {
			return true
		}
	}
	return false
}
