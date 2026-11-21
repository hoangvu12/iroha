import type { ReactNode } from "react";
import { memo, useMemo } from "react";

export type Lang = "json" | "python" | "typescript" | "shell" | "headers" | "sse" | "text";
export type TokenKind = "key" | "string" | "number" | "literal" | "keyword" | "function" | "comment";
export type Token = { text: string; kind?: TokenKind };

export const HIGHLIGHT_LIMIT = 100_000;

const STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const NUMBER = String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;

type Rule = [kind: TokenKind | ((m: string, groups: (string | undefined)[]) => Token[]), source: string];

function lexer(rules: Rule[]) {
  const re = new RegExp(rules.map(([, s]) => `(${s})`).join("|"), "g");
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

function plain(out: Token[], text: string) {
  const prev = out[out.length - 1];
  if (prev && !prev.kind) prev.text += text;
  else out.push({ text });
}

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
  ["key", String.raw`\b[A-Za-z_$][\w$]*(?=:)`],
]);

const shell = lexer([
  ["comment", String.raw`(?:^|(?<=\s))#.*`],
  ["string", String.raw`'[^']*'|"(?:[^"\\]|\\.)*"`],
  ["function", String.raw`^[A-Za-z_][\w.-]*`],
  ["keyword", String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
]);

const headerLine = lexer([["key", String.raw`^[^:\n]+(?=:)`]]);

function lexLines(text: string, lex: (t: string, out?: Token[]) => Token[]): Token[] {
  const out: Token[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    lex(line, out);
    if (i < lines.length - 1) plain(out, "\n");
  });
  return out;
}

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
