import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Code, HIGHLIGHT_LIMIT, langOf, tokens } from "./highlight";

/** The coloured tokens only, as "kind text". */
const coloured = (text: string, lang: Parameters<typeof tokens>[1]) =>
  tokens(text, lang)
    .filter((t) => t.kind)
    .map((t) => `${t.kind} ${t.text}`);

test("tokens put the text back together exactly", () => {
  const text = '{\n  "model": "gpt-4o",\n  "n": -1.5e3,\n  "ok": true,\n  "x": null\n}';
  expect(
    tokens(text, "json")
      .map((t) => t.text)
      .join(""),
  ).toBe(text);
});

test("JSON: keys, strings, numbers and literals", () => {
  expect(coloured('{"model": "gpt-4o", "n": -1.5e3, "ok": true, "x": null, "s": "a \\"q\\": b"}', "json")).toEqual([
    'key "model"',
    'string "gpt-4o"',
    'key "n"',
    "number -1.5e3",
    'key "ok"',
    "literal true",
    'key "x"',
    "literal null",
    'key "s"',
    'string "a \\"q\\": b"',
  ]);
});

test("Python: keywords, functions, keyword arguments, literals and comments", () => {
  const py = 'import os\n\nclient = OpenAI(base_url="http://x/v1", api_key=os.environ["IROHA_KEY"])\nresponse = client.chat.completions.create(\n    stream=True,\n    messages=[{"role": "user"}],\n)\n# done';
  expect(coloured(py, "python")).toEqual([
    "keyword import",
    "function OpenAI",
    "key base_url",
    'string "http://x/v1"',
    "key api_key",
    'string "IROHA_KEY"',
    "function create",
    "key stream",
    "literal True",
    "key messages",
    'key "role"',
    'string "user"',
    "comment # done",
  ]);
});

test("TypeScript: imports, awaits, object keys and template-free strings", () => {
  const ts = 'import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "http://x/v1", apiKey: process.env.IROHA_KEY });\nfor await (const chunk of response) process.stdout.write(chunk ?? ""); // tail';
  expect(coloured(ts, "typescript")).toEqual([
    "keyword import",
    "keyword from",
    'string "openai"',
    "keyword const",
    "keyword new",
    "function OpenAI",
    "key baseURL",
    'string "http://x/v1"',
    "key apiKey",
    "keyword for",
    "keyword await",
    "keyword const",
    "keyword of",
    "function write",
    'string ""',
    "comment // tail",
  ]);
});

test("curl: the command, its flags and quoted strings", () => {
  const sh = "curl -N 'http://x/v1/chat/completions' \\\n  -H \"Authorization: Bearer $IROHA_KEY\" \\\n  -d '{\"model\":\"m\"}'";
  expect(coloured(sh, "shell")).toEqual([
    "function curl",
    "keyword -N",
    "string 'http://x/v1/chat/completions'",
    "keyword -H",
    'string "Authorization: Bearer $IROHA_KEY"',
    "keyword -d",
    "string '{\"model\":\"m\"}'",
  ]);
});

test("headers: each name is a key", () => {
  expect(coloured("content-type: application/json\nretry-after: 30", "headers")).toEqual(["key content-type", "key retry-after"]);
});

test("a stream: field names, JSON payloads and comments", () => {
  const sse = 'event: message\ndata: {"a": 1}\n\n: keep-alive\ndata: [DONE]';
  expect(coloured(sse, "sse")).toEqual(["key event", "key data", 'key "a"', "number 1", "comment : keep-alive", "key data"]);
});

test("langOf tells JSON and streams from other text", () => {
  expect(langOf('{"error": {}}')).toBe("json");
  expect(langOf("  [1, 2]")).toBe("json");
  expect(langOf('data: {"x":1}\n\n')).toBe("sse");
  expect(langOf("event: error\ndata: {}")).toBe("sse");
  expect(langOf("<html>Bad Gateway</html>")).toBe("text");
});

test("Code colours tokens and keeps the text", () => {
  const { container } = render(<Code text='{"model": "m"}' lang="json" />);
  expect(container.textContent).toBe('{"model": "m"}');
  expect(container.querySelectorAll("span[data-token]").length).toBe(2);
});

test("a body over the limit is shown plain, at once", () => {
  const big = JSON.stringify({ items: Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `item-${i}` })) }, null, 2);
  expect(big.length).toBeGreaterThan(HIGHLIGHT_LIMIT);
  const started = performance.now();
  const { container } = render(<Code text={big} lang="json" />);
  expect(performance.now() - started).toBeLessThan(500);
  expect(container.textContent).toBe(big);
  expect(container.querySelectorAll("span[data-token]").length).toBe(0);
});

test("a body under the limit is tokenized quickly", () => {
  const body = JSON.stringify({ items: Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `item-${i}`, ok: i % 2 === 0 })) }, null, 2);
  expect(body.length).toBeLessThan(HIGHLIGHT_LIMIT);
  const started = performance.now();
  const out = tokens(body, "json");
  expect(performance.now() - started).toBeLessThan(100);
  expect(out.filter((t) => t.kind === "key").length).toBe(3601);
});
