// Package shape names the API formats (Shapes) a request or response can be
// written in.
package shape

type Shape string

const (
	OpenAIChat        Shape = "openai-chat"        // POST /v1/chat/completions
	OpenAIResponses   Shape = "openai-responses"   // POST /v1/responses
	AnthropicMessages Shape = "anthropic-messages" // POST /v1/messages
	Gemini            Shape = "gemini"             // POST /v1beta/models/{model}:generateContent
)

var All = []Shape{OpenAIChat, OpenAIResponses, AnthropicMessages, Gemini}

func (s Shape) Valid() bool {
	for _, x := range All {
		if s == x {
			return true
		}
	}
	return false
}

// AnthropicVersion is the anthropic-version header Iroha sends Anthropic
// Messages Endpoints when the Caller sends none (Attempts, key tests and
// model lists alike).
const AnthropicVersion = "2023-06-01"
