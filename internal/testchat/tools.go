package testchat

import (
	"encoding/json"
	"time"
)

// The test tools (UI ticket 29): made-up tools a test can offer, each
// answered by Iroha with a plausible result when the conversation comes
// back with a call to it. Nothing is fetched or looked up anywhere.

// ToolInfo is one test tool as GET /api/test/tools lists it.
type ToolInfo struct {
	Name        string          `json:"name"`
	Description string          `json:"description" doc:"One line, as the model sees it."`
	Parameters  json.RawMessage `json:"parameters" doc:"The JSON schema of the arguments, as offered to the model."`
}

// ToolList is the answer of GET /api/test/tools.
type ToolList struct {
	Tools []ToolInfo `json:"tools"`
}

// tool is a test tool and how Iroha answers a call to it.
type tool struct {
	name, description string
	params            obj
	answer            func(args map[string]any, now time.Time) obj
}

// ToolName is the tool tool_check offers on its own.
const ToolName = "get_weather"

func str(desc string) obj { return obj{{"type", "string"}, {"description", desc}} }

func params(required []any, props ...kv) obj {
	return obj{{"type", "object"}, {"properties", obj(props)}, {"required", required}}
}

// tools in the order the chat lists them.
var tools = []tool{
	{
		name: ToolName, description: "Get the current weather in a city.",
		params: params([]any{"city"}, kv{"city", str("City name, e.g. Hanoi")}),
		answer: weather,
	},
	{
		name: "get_time", description: "Get the current date and time in a time zone.",
		params: params([]any{"timezone"}, kv{"timezone", str("IANA time zone, e.g. Asia/Ho_Chi_Minh or UTC")}),
		answer: clockTime,
	},
	{
		name: "calculate", description: "Evaluate an arithmetic expression exactly.",
		params: params([]any{"expression"}, kv{"expression", str("e.g. (12.5 * 4) / 3 + 2^10; supports + - * / % ^, parentheses, sqrt, abs, round, floor, ceil, pi, e")}),
		answer: calculation,
	},
	{
		name: "web_search", description: "Search the web and return the top results.",
		params: params([]any{"query"}, kv{"query", str("What to search for")}, kv{"max_results", obj{{"type", "integer"}, {"description", "1 to 5, default 3"}}}),
		answer: webSearch,
	},
	{
		name: "fetch_url", description: "Fetch a web page and return its title and text.",
		params: params([]any{"url"}, kv{"url", str("The page's http or https URL")}),
		answer: page,
	},
	{
		name: "lookup_order", description: "Look up an order by its ID: status, items, shipping and total.",
		params: params([]any{"order_id"}, kv{"order_id", str("The order ID, e.g. ORD-10482")}),
		answer: order,
	},
}

func toolNamed(name string) *tool {
	for i := range tools {
		if tools[i].name == name {
			return &tools[i]
		}
	}
	return nil
}

// ToolNames lists every test tool's name.
func ToolNames() []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		out[i] = t.name
	}
	return out
}

// Tools lists the test tools.
func Tools() ToolList {
	out := ToolList{Tools: make([]ToolInfo, len(tools))}
	for i, t := range tools {
		p, _ := t.params.MarshalJSON()
		out.Tools[i] = ToolInfo{Name: t.name, Description: t.description, Parameters: p}
	}
	return out
}
