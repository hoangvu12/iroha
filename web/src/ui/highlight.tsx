import type { ReactNode } from "react";
import { memo, useMemo } from "react";

// Syntax highlighting for code blocks (UI ticket 23): a small tokenizer
// instead of a library. Everything Iroha shows is JSON (bodies, Audit Entry
// values), headers, a stream's events, or a snippet Iroha itself wrote (curl,
// Python, TypeScript), so a handful of regular expressions colour all of it;
// Prism with these grammars would cost ~9 KB gzipped and a global, this ~1.5.
// Colours are the --code-* tokens in styles/index.css (light and dark).

export type Lang = "json" | "python" | "typescript" | "shell" | "headers" | "sse" | "text";
export type TokenKind = "key" | "string" | "number" | "literal" | "keyword" | "function" | "comment";
export type Token = { text: string; kind?: TokenKind };

/**
 * Text longer than this is shown plain: a few hundred KB of coloured spans
 * would take the page seconds to lay out. Highlighting below it takes a few
 * milliseconds.
 */
export const HIGHLIGHT_LIMIT = 100_000;

const STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const NUMBER = String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;

type Rule = [kind: TokenKind | ((m: string, groups: (string | undefined)[]) => Token[]), source: string];

/** One lexer: alternatives tried left to right at each position; text between matches stays plain. */
function lexer(rules: Rule[]) {
  const re = new RegExp(rules.map(([, s]) => `(${s})`).join("|"), "g");
  // Where each rule's group starts, and how many groups of its own it has.
  const inner = rules.map(([, s]) => new RegExp(`${s}|`).exec("")!.length - 1);
  const starts: number[] = [];
  inner.reduce((g, n) => (starts.push(g), g + 1 + n), 1);
  return (text: string, out: Token[] = []): Token[] => {
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const i = starts.findIndex((s) => m[s] !== undefined);
      if (m.index > last) plain(out, text.slice(last, m.index));
      const kind = rules[i][0];
      if (typeof kind === "function") {
        const groups = m.slice(starts[i] + 1, starts[i] + 1 + inner[i]);
        for (const t of kind(m[0], groups)) {
          if (t.kind) out.push(t);
          else plain(out, t.text);
        }
      } else out.push({ text: m[0], kind });
      last = m.index + m[0].length;
    }
    if (last < text.length) plain(out, text.slice(last));
    return out;
  };
}

/** Adds plain text, joined to plain text before it (fewer nodes). */
function plain(out: Token[], text: string) {
  const prev = out[out.length - 1];
  if (prev && !prev.kind) prev.text += text;
  else out.push({ text });
}

/** A string followed by a colon is a key: `"model": ...`. */
const stringOrKey: Rule = [(_, [str, colon]) => [{ text: str!, kind: colon !== undefined ? "key" : "string" }, ...(colon ? [{ text: colon }] : [])], `(${STRING})(\\s*:)?`];

const json = lexer([stringOrKey, ["number", NUMBER], ["literal", String.raw`\b(?:true|false|null)\b`]]);

const words = (list: string) => String.raw`\b(?:${list.split(" ").join("|")})\b`;
const call: Rule = ["function", String.raw`\b[A-Za-z_$][\w$]*(?=\()`];

const python = lexer([
  ["comment", "#.*"],
  stringOrKey,
  ["string", String.raw`'(?:[^'\\\n]|\\.)*'`],
  ["keyword", words("import from as def return if elif else for while in not and or is with class try except finally raise lambda yield async await pass break continue global")],
  ["literal", words("True False None")],
  ["number", NUMBER],
  call,
  // A keyword argument: name=value (not ==).
  ["key", String.raw`\b[A-Za-z_]\w*(?==(?!=))`],
]);

const typescript = lexer([
  ["comment", String.raw`\/\/.*|\/\*[\s\S]*?\*\/`],
  stringOrKey,
  ["string", String.raw`'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\]|\\\\.)*`"],
  ["keyword", words("import from export as const let var function return if else for while of in new await async try catch finally throw typeof instanceof default class extends")],
  ["literal", words("true false null undefined")],
  ["number", NUMBER],
  call,
  // An object key: name: value.
  ["key", String.raw`\b[A-Za-z_$][\w$]*(?=:)`],
]);

const shell = lexer([
  ["comment", String.raw`(?:^|(?<=\s))#.*`],
  ["string", String.raw`'[^']*'|"(?:[^"\\]|\\.)*"`],
  // The command at the start of a line.
  ["function", String.raw`^[A-Za-z_][\w.-]*`],
  ["keyword", String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
]);

const headerLine = lexer([["key", String.raw`^[^:\n]+(?=:)`]]);

/** Runs a line-anchored lexer per line (`^` means the line's start). */
function lexLines(text: string, lex: (t: string, out?: Token[]) => Token[]): Token[] {
  const out: Token[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    lex(line, out);
    if (i < lines.length - 1) plain(out, "\n");
  });
  return out;
}

/** A stream as sent: `event: x`, `data: {json}`, `: comment`. */
function sse(text: string): Token[] {
  return lexLines(text, (line, out = []) => {
    if (line.startsWith(":")) {
      out.push({ text: line, kind: "comment" });
      return out;
    }
    const m = /^([A-Za-z]+):( ?)(.*)$/.exec(line);
    if (!m) {
      plain(out, line);
      return out;
    }
    out.push({ text: m[1], kind: "key" });
    plain(out, ":" + m[2]);
    if (m[1] === "data") json(m[3], out);
    else plain(out, m[3]);
    return out;
  });
}

/** The text split into tokens; joined back it is the same text. */
export function tokens(text: string, lang: Lang): Token[] {
  switch (lang) {
    case "json":
      return json(text);
    case "python":
      return python(text);
    case "typescript":
      return typescript(text);
    case "shell":
      return lexLines(text, shell);
    case "headers":
      return lexLines(text, headerLine);
    case "sse":
      return sse(text);
    default:
      return [{ text }];
  }
}

/** JSON, a stream, or other text (an HTML error page): what a body looks like. */
export function langOf(text: string): Lang {
  const start = text.trimStart();
  if (start.startsWith("{") || start.startsWith("[")) return "json";
  if (/^(?:data|event|id|retry):/.test(start)) return "sse";
  return "text";
}

const colour: Record<TokenKind, string> = {
  key: "text-code-key",
  string: "text-code-string",
  number: "text-code-number",
  literal: "text-code-literal",
  keyword: "text-code-keyword",
  function: "text-code-function",
  comment: "text-code-comment",
};

/** Text coloured by `lang`; plain above HIGHLIGHT_LIMIT. Renders a fragment, so put it in a `<pre>` or `<code>`. */
export const Code = memo(function Code({ text, lang }: { text: string; lang: Lang }) {
  const nodes = useMemo((): ReactNode => {
    if (lang === "text" || text.length > HIGHLIGHT_LIMIT) return text;
    return tokens(text, lang).map((t, i) =>
      t.kind ? (
        <span key={i} data-token={t.kind} className={colour[t.kind]}>
          {t.text}
        </span>
      ) : (
        t.text
      ),
    );
  }, [text, lang]);
  return <>{nodes}</>;
});
