package testchat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Snippets are ready-to-run programs sending a test's request to the
// Gateway as a Caller would: the global route of its Shape, its body, the
// Gateway Key in the Shape's usual header.
type Snippets struct {
	URL        string `json:"url" doc:"The Gateway URL the snippets call."`
	Curl       string `json:"curl"`
	Python     string `json:"python" doc:"Uses the openai or anthropic package (pip install openai / anthropic); Gemini uses the standard library."`
	TypeScript string `json:"typescript" doc:"Uses the openai or @anthropic-ai/sdk package; Gemini uses fetch. Runs on Node 18+ as an ES module."`
	KeyEnv     bool   `json:"key_env" doc:"true: no Gateway Key was named (as), so the snippets read one from the IROHA_KEY environment variable."`
	Note       string `json:"note,omitempty" doc:"What the snippets do not carry, e.g. a pinned Upstream Key or Endpoint (test-only settings)."`
}

// KeyEnv is the environment variable snippets read the Gateway Key from
// when the test is not sent as one.
const KeyEnv = "IROHA_KEY"

// MakeSnippets writes the snippets for b against the Gateway at base (no
// trailing slash). secret is the Gateway Key to embed; "" reads IROHA_KEY.
func MakeSnippets(s Send, b Built, base, secret string) Snippets {
	base = strings.TrimRight(base, "/")
	url := base + b.Path
	if b.Shape == shape.Gemini && b.Stream {
		url += "?alt=sse"
	}
	out := Snippets{URL: url, KeyEnv: secret == ""}
	out.Curl = curlSnippet(b, url, secret)
	out.Python = pythonSnippet(b, base, url, secret)
	out.TypeScript = tsSnippet(b, base, url, secret)
	var pinned []string
	if s.UpstreamKey != "" {
		pinned = append(pinned, "Upstream Key "+s.UpstreamKey)
	}
	if s.Endpoint != "" {
		pinned = append(pinned, "Endpoint "+s.Endpoint)
	}
	if len(pinned) > 0 {
		out.Note = "Pinning to " + strings.Join(pinned, " and ") + " is a test-only setting: these snippets are routed like any Caller's Request."
	}
	return out
}

// authHeader is the header a Caller of the Shape usually sends its key in.
func authHeader(sh shape.Shape) (name, prefix string) {
	switch sh {
	case shape.AnthropicMessages:
		return "x-api-key", ""
	case shape.Gemini:
		return "x-goog-api-key", ""
	}
	return "Authorization", "Bearer "
}

func curlSnippet(b Built, url, secret string) string {
	key := secret
	if key == "" {
		key = "$" + KeyEnv
	}
	name, prefix := authHeader(b.Shape)
	lines := []string{"curl " + shellQuote(url)}
	if b.Stream {
		lines[0] = "curl -N " + shellQuote(url)
	}
	if secret == "" {
		lines = append(lines, `  -H "`+name+": "+prefix+key+`"`)
	} else {
		lines = append(lines, "  -H "+shellQuote(name+": "+prefix+key))
	}
	lines = append(lines, `  -H "Content-Type: application/json"`)
	if b.Shape == shape.AnthropicMessages {
		lines = append(lines, `  -H "anthropic-version: `+shape.AnthropicVersion+`"`)
	}
	lines = append(lines, "  -d "+shellQuote(string(b.Body)))
	return strings.Join(lines, " \\\n") + "\n"
}

// shellQuote quotes s for a POSIX shell.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func pyString(s string) string {
	b, _ := marshal(s)
	return string(b)
}

func pythonSnippet(b Built, base, url, secret string) string {
	var w strings.Builder
	key := pyString(secret)
	if secret == "" {
		key = `os.environ["` + KeyEnv + `"]`
	}
	kwargs := func() string {
		var k strings.Builder
		for _, f := range topLevel(b.Body) {
			fmt.Fprintf(&k, "    %s=%s,\n", f.key, literal(f.value, 1, python))
		}
		return k.String()
	}
	switch b.Shape {
	case shape.OpenAIChat, shape.OpenAIResponses:
		if secret == "" {
			w.WriteString("import os\n\n")
		}
		w.WriteString("from openai import OpenAI\n\n")
		fmt.Fprintf(&w, "client = OpenAI(base_url=%s, api_key=%s)\n\n", pyString(base+"/v1"), key)
		call := "client.chat.completions.create"
		if b.Shape == shape.OpenAIResponses {
			call = "client.responses.create"
		}
		fmt.Fprintf(&w, "response = %s(\n%s)\n", call, kwargs())
		switch {
		case b.Shape == shape.OpenAIChat && b.Stream:
			w.WriteString("for chunk in response:\n    if chunk.choices and chunk.choices[0].delta.content:\n        print(chunk.choices[0].delta.content, end=\"\", flush=True)\n    if chunk.choices and chunk.choices[0].delta.tool_calls:\n        for call in chunk.choices[0].delta.tool_calls:\n            print(call.function.name or \"\", call.function.arguments or \"\", end=\"\", flush=True)\nprint()\n")
		case b.Shape == shape.OpenAIChat:
			w.WriteString("message = response.choices[0].message\nprint(message.content or message.tool_calls)\n")
		case b.Stream:
			w.WriteString("for event in response:\n    if event.type == \"response.output_text.delta\":\n        print(event.delta, end=\"\", flush=True)\n    elif event.type == \"response.output_item.done\" and event.item.type == \"function_call\":\n        print(event.item.name, event.item.arguments)\nprint()\n")
		default:
			w.WriteString("print(response.output_text or response.output)\n")
		}
	case shape.AnthropicMessages:
		if secret == "" {
			w.WriteString("import os\n\n")
		}
		w.WriteString("from anthropic import Anthropic\n\n")
		fmt.Fprintf(&w, "client = Anthropic(base_url=%s, api_key=%s)\n\n", pyString(base), key)
		fmt.Fprintf(&w, "response = client.messages.create(\n%s)\n", kwargs())
		if b.Stream {
			w.WriteString("for event in response:\n    if event.type == \"content_block_delta\" and event.delta.type == \"text_delta\":\n        print(event.delta.text, end=\"\", flush=True)\n    elif event.type == \"content_block_start\" and event.content_block.type == \"tool_use\":\n        print(event.content_block.name, end=\" \", flush=True)\n    elif event.type == \"content_block_delta\" and event.delta.type == \"input_json_delta\":\n        print(event.delta.partial_json, end=\"\", flush=True)\nprint()\n")
		} else {
			w.WriteString("print(response.content)\n")
		}
	case shape.Gemini:
		w.WriteString("import json\n")
		if secret == "" {
			w.WriteString("import os\n")
		}
		w.WriteString("import urllib.request\n\n")
		fmt.Fprintf(&w, "body = %s\n\n", literal(b.Body, 0, python))
		fmt.Fprintf(&w, "request = urllib.request.Request(\n    %s,\n    data=json.dumps(body).encode(),\n    headers={\"x-goog-api-key\": %s, \"Content-Type\": \"application/json\"},\n)\n", pyString(url), key)
		if b.Stream {
			w.WriteString("with urllib.request.urlopen(request) as response:\n    for line in response:\n        if not line.startswith(b\"data: \"):\n            continue\n        chunk = json.loads(line[6:])\n        for candidate in chunk.get(\"candidates\", []):\n            for part in candidate.get(\"content\", {}).get(\"parts\", []):\n                if \"text\" in part and not part.get(\"thought\"):\n                    print(part[\"text\"], end=\"\", flush=True)\n                elif \"functionCall\" in part:\n                    print(json.dumps(part[\"functionCall\"]), end=\"\", flush=True)\nprint()\n")
		} else {
			w.WriteString("with urllib.request.urlopen(request) as response:\n    print(json.dumps(json.load(response), indent=2))\n")
		}
	}
	return w.String()
}

func tsSnippet(b Built, base, url, secret string) string {
	var w strings.Builder
	key := pyString(secret)
	if secret == "" {
		key = "process.env." + KeyEnv
	}
	args := literal(b.Body, 0, typescript)
	switch b.Shape {
	case shape.OpenAIChat, shape.OpenAIResponses:
		w.WriteString("import OpenAI from \"openai\";\n\n")
		fmt.Fprintf(&w, "const client = new OpenAI({ baseURL: %s, apiKey: %s });\n\n", pyString(base+"/v1"), key)
		call := "client.chat.completions.create"
		if b.Shape == shape.OpenAIResponses {
			call = "client.responses.create"
		}
		fmt.Fprintf(&w, "const response = await %s(%s);\n", call, args)
		switch {
		case b.Shape == shape.OpenAIChat && b.Stream:
			w.WriteString("for await (const chunk of response) {\n  const delta = chunk.choices[0]?.delta;\n  process.stdout.write(delta?.content ?? \"\");\n  for (const call of delta?.tool_calls ?? []) process.stdout.write((call.function?.name ?? \"\") + (call.function?.arguments ?? \"\"));\n}\nprocess.stdout.write(\"\\n\");\n")
		case b.Shape == shape.OpenAIChat:
			w.WriteString("const message = response.choices[0].message;\nconsole.log(message.content ?? message.tool_calls);\n")
		case b.Stream:
			w.WriteString("for await (const event of response) {\n  if (event.type === \"response.output_text.delta\") process.stdout.write(event.delta);\n  else if (event.type === \"response.output_item.done\" && event.item.type === \"function_call\") console.log(event.item.name, event.item.arguments);\n}\nprocess.stdout.write(\"\\n\");\n")
		default:
			w.WriteString("console.log(response.output_text || response.output);\n")
		}
	case shape.AnthropicMessages:
		w.WriteString("import Anthropic from \"@anthropic-ai/sdk\";\n\n")
		fmt.Fprintf(&w, "const client = new Anthropic({ baseURL: %s, apiKey: %s });\n\n", pyString(base), key)
		fmt.Fprintf(&w, "const response = await client.messages.create(%s);\n", args)
		if b.Stream {
			w.WriteString("for await (const event of response) {\n  if (event.type === \"content_block_delta\" && event.delta.type === \"text_delta\") process.stdout.write(event.delta.text);\n  else if (event.type === \"content_block_start\" && event.content_block.type === \"tool_use\") process.stdout.write(event.content_block.name + \" \");\n  else if (event.type === \"content_block_delta\" && event.delta.type === \"input_json_delta\") process.stdout.write(event.delta.partial_json);\n}\nprocess.stdout.write(\"\\n\");\n")
		} else {
			w.WriteString("console.log(response.content);\n")
		}
	case shape.Gemini:
		fmt.Fprintf(&w, "const response = await fetch(%s, {\n  method: \"POST\",\n  headers: { \"x-goog-api-key\": %s, \"Content-Type\": \"application/json\" },\n  body: JSON.stringify(%s),\n});\n", pyString(url), key, literal(b.Body, 1, typescript))
		if b.Stream {
			w.WriteString("const decoder = new TextDecoder();\nlet buffer = \"\";\nfor await (const piece of response.body) {\n  buffer += decoder.decode(piece, { stream: true });\n  let end;\n  while ((end = buffer.indexOf(\"\\n\")) >= 0) {\n    const line = buffer.slice(0, end).trim();\n    buffer = buffer.slice(end + 1);\n    if (!line.startsWith(\"data: \")) continue;\n    for (const candidate of JSON.parse(line.slice(6)).candidates ?? [])\n      for (const part of candidate.content?.parts ?? [])\n        if (part.text && !part.thought) process.stdout.write(part.text);\n        else if (part.functionCall) process.stdout.write(JSON.stringify(part.functionCall));\n  }\n}\nprocess.stdout.write(\"\\n\");\n")
		} else {
			w.WriteString("console.log(JSON.stringify(await response.json(), null, 2));\n")
		}
	}
	return w.String()
}

type flavor int

const (
	python flavor = iota
	typescript
)

type field struct {
	key   string
	value json.RawMessage
}

// topLevel lists an object's fields in order.
func topLevel(raw []byte) []field {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	var out []field
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return out
		}
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return out
		}
		out = append(out, field{key: k.(string), value: v})
	}
	return out
}

var identifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// literal writes a JSON value as a Python or TypeScript literal, indented
// by two (TypeScript) or four (Python) spaces per level, keys in order.
func literal(raw []byte, depth int, f flavor) string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var b strings.Builder
	unit := "  "
	if f == python {
		unit = "    "
	}
	pad := func(d int) string { return strings.Repeat(unit, d) }
	var value func(d int)
	value = func(d int) {
		tok, err := dec.Token()
		if err != nil {
			return
		}
		switch t := tok.(type) {
		case json.Delim:
			open, close := string(t), "}"
			if t == '[' {
				close = "]"
			}
			if !dec.More() {
				_, _ = dec.Token()
				b.WriteString(open + close)
				return
			}
			b.WriteString(open + "\n")
			first := true
			for dec.More() {
				if !first {
					b.WriteString(",\n")
				}
				first = false
				b.WriteString(pad(d + 1))
				if t == '{' {
					k, _ := dec.Token()
					ks := k.(string)
					if f == typescript && identifier.MatchString(ks) {
						b.WriteString(ks)
					} else {
						b.WriteString(pyString(ks))
					}
					b.WriteString(": ")
				}
				value(d + 1)
			}
			_, _ = dec.Token()
			if f == typescript {
				b.WriteString(",")
			}
			b.WriteString("\n" + pad(d) + close)
		case string:
			b.WriteString(pyString(t))
		case json.Number:
			b.WriteString(t.String())
		case bool:
			switch {
			case f == python && t:
				b.WriteString("True")
			case f == python:
				b.WriteString("False")
			default:
				fmt.Fprint(&b, t)
			}
		case nil:
			if f == python {
				b.WriteString("None")
			} else {
				b.WriteString("null")
			}
		}
	}
	value(depth)
	return b.String()
}

// marshal is json.Marshal without HTML escaping.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
